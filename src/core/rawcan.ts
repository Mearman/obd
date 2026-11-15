/**
 * A raw CAN link presented as an ELM327 adapter, so the same session code drives either.
 *
 * The ELM327 commands the session sends are interpreted here and the ISO 15765-2 work, which an
 * ELM327 does in firmware, is done by `isotp`. Requests arrive already passed by the guard: this
 * layer adds nothing to the bus beyond the frames of one request and the flow-control frames its
 * reply needs. Commands the session does not use, and the settings this layer does not implement,
 * are answered `?` as a clone adapter would.
 */

import {
  asciiDecode,
  asciiEncode,
  byteAt,
  concatBytes,
  fromHex,
  hexNumber,
  toUpperHex,
} from "./bytes.js";
import { CanFrame, type CanLink } from "./can.js";
import {
  CAN_PROTOCOLS,
  EXTENDED_TESTER_ADDRESS,
  USER_PROTOCOL_BASE_RATE,
  USER_PROTOCOL_ISO15765_11_BIT,
  USER_PROTOCOL_ISO15765_29_BIT,
  USER_PROTOCOL_MAX_DIVISOR,
} from "./elm.js";
import { IsoTpError, Receiver, flowControlFrame, pad, sendMessage } from "./isotp.js";
import { now } from "./time.js";
import { TransportError, TransportTimeout, type Transport } from "./transport.js";

const IDENTITY = "OBD-READ RAW CAN";

/** Longest request, in bytes, that ISO-TP segmentation can carry. */
export const MAX_REQUEST = 0xfff;

/** Settings the session sends that this layer's fixed behaviour already satisfies. */
const ACCEPTED: ReadonlySet<string> = new Set([
  "ATE0",
  "ATL0",
  "ATS0",
  "ATH1",
  "ATCAF1",
  "ATAT0",
  "ATFCSM0",
  "ATFCSM1",
]);

// ISO 15765-4 response identifier range for 11-bit physical addressing, and the 29-bit prefix that
// carries the tester address in its low byte.
const RESPONSE_11_FIRST = 0x7e8;
const RESPONSE_11_LAST = 0x7ef;
const RESPONSE_29_MASK = 0x1fffff00;
const RESPONSE_29_PREFIX = 0x18daf100;

// A negative response "response pending" means the final answer is still to come.
const NEGATIVE_RESPONSE = 0x7f;
const RESPONSE_PENDING = 0x78;

/** The reply timeout the adapter starts with, in milliseconds: the longest `ATST` value. */
const DEFAULT_TIMEOUT_MS = 0xff * 4;

/** Swaps the two address bytes at the bottom of a 29-bit ISO 15765-4 identifier. */
export function swapAddresses(canId: number): number {
  return (canId & 0xffff0000) | ((canId & 0xff) << 8) | ((canId >> 8) & 0xff);
}

/**
 * The request identifier a response identifier answers: 11-bit minus 8, or 29-bit with target and
 * source swapped.
 */
export function requestFor(responseId: number, idBits: number): number {
  return idBits === 11 ? responseId - 8 : swapAddresses(responseId);
}

/**
 * The response identifier a request identifier is answered on: 11-bit plus 8, or 29-bit with target
 * and source swapped.
 */
export function responseFor(requestId: number, idBits: number): number {
  return idBits === 11 ? requestId + 8 : swapAddresses(requestId);
}

/** An ELM327 look-alike on a raw CAN link. */
export class RawCanTransport implements Transport {
  /** The longest request this transport takes as a plain request line; pass it to the session. */
  readonly maxRequest = MAX_REQUEST;

  private output: Uint8Array = new Uint8Array(0);
  private partial: Uint8Array = new Uint8Array(0);
  private idBits = 11;
  private headerHigh = 0;
  private headerLow: number | undefined;
  private receiveAddress: number | undefined;
  private flowHeader: number | undefined;
  private flowData: Uint8Array = new Uint8Array(0);
  private flowMode = 0;
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private userProtocol: readonly [idBits: number, bitrate: number] | undefined;
  private extendedAddress: number | undefined;

  constructor(
    private readonly canLink: CanLink,
    private readonly description = "",
  ) {}

  private reset(): void {
    this.idBits = 11;
    this.headerHigh = 0;
    this.headerLow = undefined;
    this.receiveAddress = undefined;
    this.flowHeader = undefined;
    this.flowData = new Uint8Array(0);
    this.flowMode = 0;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    this.userProtocol = undefined;
    this.extendedAddress = undefined;
  }

  /** The raw CAN link, for a caller that reads frames directly, such as the bus monitor. */
  get link(): CanLink {
    return this.canLink;
  }

  open(): Promise<void> {
    return this.canLink.open();
  }

  close(): Promise<void> {
    return this.canLink.close();
  }

  async write(data: Uint8Array): Promise<void> {
    this.partial = concatBytes(this.partial, data);
    for (let end = this.partial.indexOf(0x0d); end >= 0; end = this.partial.indexOf(0x0d)) {
      const line = this.partial.slice(0, end);
      this.partial = this.partial.slice(end + 1);
      const reply = await this.handle(asciiDecode(line).replaceAll(" ", "").toUpperCase());
      this.output = concatBytes(this.output, asciiEncode(`${reply.replaceAll("\n", "\r")}\r\r>`));
    }
  }

  /**
   * Returns everything the adapter has said so far.
   *
   * @throws TransportTimeout at once, without waiting, when there is nothing to say.
   */
  read(): Promise<Uint8Array> {
    if (this.output.length === 0) {
      return Promise.reject(new TransportTimeout("the raw CAN link has nothing to say"));
    }
    const data = this.output;
    this.output = new Uint8Array(0);
    return Promise.resolve(data);
  }

  private async handle(line: string): Promise<string> {
    if (ACCEPTED.has(line)) {
      if (line.startsWith("ATFCSM")) this.flowMode = Number(line.slice(-1));
      return "OK";
    }
    if (line === "ATZ") {
      this.reset();
      return `${IDENTITY} ${this.description}`.trim();
    }
    if (line === "ATI") return IDENTITY;
    if (line === "ATPC") return "OK";
    if (/^ATPB[0-9A-F]{4}$/.test(line)) {
      return this.defineUserProtocol(
        Number.parseInt(line.slice(4, 6), 16),
        Number.parseInt(line.slice(6), 16),
      );
    }
    if (line === "ATSPB") {
      return this.userProtocol === undefined ? "?" : this.start(...this.userProtocol);
    }
    if (/^ATSP[0-9A-F]$/.test(line)) return this.selectProtocol(line.slice(4));
    if (
      (/^ATSH[0-9A-F]{3}$/.test(line) && this.idBits === 11) ||
      (/^ATSH[0-9A-F]{6}$/.test(line) && this.idBits === 29)
    ) {
      this.headerLow = Number.parseInt(line.slice(4), 16);
      return "OK";
    }
    if (/^ATCP[0-9A-F]{2}$/.test(line) && this.idBits === 29) {
      this.headerHigh = Number.parseInt(line.slice(4), 16) & 0x1f;
      return "OK";
    }
    if (
      (/^ATCRA[0-9A-F]{3}$/.test(line) && this.idBits === 11) ||
      (/^ATCRA[0-9A-F]{8}$/.test(line) && this.idBits === 29)
    ) {
      this.receiveAddress = Number.parseInt(line.slice(5), 16);
      return "OK";
    }
    if (line === "ATAR") {
      this.receiveAddress = undefined;
      return "OK";
    }
    if (
      (/^ATFCSH[0-9A-F]{3}$/.test(line) && this.idBits === 11) ||
      (/^ATFCSH[0-9A-F]{8}$/.test(line) && this.idBits === 29)
    ) {
      this.flowHeader = Number.parseInt(line.slice(6), 16);
      return "OK";
    }
    if (/^ATFCSD(?:[0-9A-F]{2}){1,5}$/.test(line)) {
      this.flowData = fromHex(line.slice(6));
      return "OK";
    }
    // CAN extended addressing as the ELM327 does it: the address goes first in every frame sent,
    // and only replies that start with the tester address are passed on, address included.
    if (line === "ATCEA") {
      this.extendedAddress = undefined;
      return "OK";
    }
    if (/^ATCEA[0-9A-F]{2}$/.test(line)) {
      this.extendedAddress = Number.parseInt(line.slice(5), 16);
      return "OK";
    }
    if (line === "ATSTFF" || /^ATST[0-9A-F]{2}$/.test(line)) {
      this.timeoutMs = Math.max(1, Number.parseInt(line.slice(4), 16)) * 4;
      return "OK";
    }
    if (/^(?:[0-9A-F]{2})+$/.test(line)) return this.request(fromHex(line));
    return "?";
  }

  private async selectProtocol(number: string): Promise<string> {
    const protocol = CAN_PROTOCOLS.find((entry) => entry.protocol === number);
    return protocol === undefined ? "?" : this.start(protocol.idBits, protocol.bitrate);
  }

  /** Takes the session's `ATPB`: the options byte names the identifier width and the divisor sets the rate. */
  private defineUserProtocol(options: number, divisor: number): string {
    let width: number;
    if (options === USER_PROTOCOL_ISO15765_11_BIT) width = 11;
    else if (options === USER_PROTOCOL_ISO15765_29_BIT) width = 29;
    else return "?";
    if (divisor < 1 || divisor > USER_PROTOCOL_MAX_DIVISOR) return "?";
    this.userProtocol = [width, Math.floor(USER_PROTOCOL_BASE_RATE / divisor)];
    return "OK";
  }

  private async start(idBits: number, bitrate: number): Promise<string> {
    this.idBits = idBits;
    this.headerLow = undefined;
    this.receiveAddress = undefined;
    await this.canLink.configure(bitrate, false);
    return "OK";
  }

  private accepts(canId: number): boolean {
    if (this.receiveAddress !== undefined) return canId === this.receiveAddress;
    if (this.idBits === 11) return canId >= RESPONSE_11_FIRST && canId <= RESPONSE_11_LAST;
    return (canId & RESPONSE_29_MASK) === RESPONSE_29_PREFIX;
  }

  private flowTarget(sender: number, requestId: number): number {
    if (this.flowMode === 1 && this.flowHeader !== undefined) return this.flowHeader;
    if (this.receiveAddress !== undefined) return requestId;
    return requestFor(sender, this.idBits);
  }

  private async request(payload: Uint8Array): Promise<string> {
    if (this.headerLow === undefined) return "?";
    const extended = this.idBits === 29;
    const requestId = (extended ? this.headerHigh << 24 : 0) | this.headerLow;
    const digits = extended ? 8 : 3;
    const addressing =
      this.extendedAddress === undefined
        ? undefined
        : { target: this.extendedAddress, source: EXTENDED_TESTER_ADDRESS };
    const receiver = new Receiver(addressing?.source);
    const lines: string[] = [];
    let final = false;
    try {
      const expectedFlow = this.receiveAddress ?? responseFor(requestId, this.idBits);
      const queued = await sendMessage(
        this.canLink,
        requestId,
        extended,
        payload,
        expectedFlow,
        this.timeoutMs,
        addressing,
      );
      const deadline = now() + this.timeoutMs;
      const pending: CanFrame[] = [...queued];
      while (!final) {
        let frame = pending.shift();
        if (frame === undefined) {
          const remaining = deadline - now();
          if (remaining <= 0) break;
          try {
            frame = await this.canLink.receive(remaining);
          } catch (error) {
            if (error instanceof TransportTimeout) break;
            throw error;
          }
        }
        if (frame.extended !== extended || !this.accepts(frame.canId)) continue;
        const received = receiver.feed(frame.canId, frame.data);
        if (received.sendFlowControl) {
          const control =
            this.flowMode === 1 && this.flowData.length > 0
              ? pad(this.flowData)
              : flowControlFrame(0, 0, addressing?.target);
          const target = this.flowTarget(frame.canId, requestId);
          await this.canLink.send(new CanFrame(target, control, extended));
        }
        if (received.message !== undefined) {
          for (const raw of received.frames) {
            lines.push(`${hexNumber(frame.canId, digits)}${toUpperHex(raw)}`);
          }
          const answered = received.message;
          const pendingAnswer =
            answered.length >= 3 &&
            byteAt(answered, 0) === NEGATIVE_RESPONSE &&
            byteAt(answered, 2) === RESPONSE_PENDING;
          final = this.receiveAddress !== undefined && !pendingAnswer;
        }
      }
      const incomplete = receiver.incomplete();
      if (incomplete.length > 0) {
        const senders = incomplete.map((sender) => hexNumber(sender, 1)).join(", ");
        return `CAN ERROR: multi-frame reply cut short from ${senders}`;
      }
    } catch (error) {
      if (error instanceof IsoTpError || error instanceof TransportError) {
        return `CAN ERROR: ${error.message}`;
      }
      throw error;
    }
    return lines.length > 0 ? lines.join("\n") : "NO DATA";
  }
}
