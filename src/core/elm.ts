/** An ELM327 session: adapter set-up, addressing and one request with its replies. */

import { asciiDecode, asciiEncode, byteAt, fromHex, hexNumber, toUpperHex } from "./bytes.js";
import type { Permit } from "./guard.js";
import { now } from "./time.js";
import { TransportTimeout, type Transport } from "./transport.js";

/** The byte the adapter ends every reply with: ">". */
export const PROMPT = 0x3e;

/** Longest request the adapter can send as a single CAN frame: 8 data bytes less the length byte. */
export const MAX_SINGLE_FRAME = 7;

/** Longest diagnostic message ISO 15765-2 can carry: the first frame's length field is 12 bits. */
export const MAX_ISOTP_MESSAGE = 4095;

/** CAN data bytes per frame. */
export const FRAME_BYTES = 8;

/**
 * The tester address the adapter expects first in every reply under CAN extended addressing: the
 * datasheet's `AT TA` default, which this tool never changes. With `AT CEA hh` set the adapter
 * "only [passes] ones that have the Tester Address in the first byte position".
 * Source: ELM327 datasheet, "CEA hh" and "RA hh" ("CAN Extended Addressing does not use this value
 * - it uses the one set by the AT TA command");
 * https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
 */
export const EXTENDED_TESTER_ADDRESS = 0xf1;

/** ELM327 protocol numbers for ISO 15765-4 CAN, keyed by identifier bits and bit rate. */
export const CAN_PROTOCOLS: readonly { idBits: number; bitrate: number; protocol: string }[] = [
  { idBits: 11, bitrate: 500_000, protocol: "6" },
  { idBits: 29, bitrate: 500_000, protocol: "7" },
  { idBits: 11, bitrate: 250_000, protocol: "8" },
  { idBits: 29, bitrate: 250_000, protocol: "9" },
];

/** The 500 kbit/s protocol number for each identifier width. */
const BASE_RATE_PROTOCOL: Record<11 | 29, string> = { 11: "6", 29: "7" };

function canProtocol(idBits: number, bitrate: number): string | undefined {
  return CAN_PROTOCOLS.find((entry) => entry.idBits === idBits && entry.bitrate === bitrate)
    ?.protocol;
}

// The ELM327 user-defined CAN protocol B takes its bit rate as a divisor of 500 kbit/s: "baud rate
// (in kbps) = 500 / (PP 2B value)", the same rule for PP 2D, which holds protocol B's divisor,
// accepting 01 to 40 hex.
// Source: ELM327 datasheet (Elm Electronics, ELM327DSJ), "Programmable Parameter Summary", PP 2B
// to 2D; https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
/** The rate user-defined protocol B divides to reach its bit rate. */
export const USER_PROTOCOL_BASE_RATE = 500_000;
/** The largest divisor user-defined protocol B accepts. */
export const USER_PROTOCOL_MAX_DIVISOR = 0x40;

// Protocol B options byte (PP 2C). Bit 7 set means an 11-bit transmit identifier, clear means
// 29-bit; bit 6 clear means fixed 8-byte frames, which ISO 15765-4 requires; bits 2 to 0 equal to
// 001 select ISO 15765-4 data formatting, so ATCAF1 and the flow-control commands behave as they do
// on protocols 6 to 9.
// Source: the same datasheet, PP 2C; its AT PB example for 11-bit ISO 15765 at 50 kbit/s is
// `AT PB 81 0A`.
/** The protocol B options byte for ISO 15765-4 with 11-bit identifiers. */
export const USER_PROTOCOL_ISO15765_11_BIT = 0x81;
/** The protocol B options byte for ISO 15765-4 with 29-bit identifiers. */
export const USER_PROTOCOL_ISO15765_29_BIT = 0x01;

/** Replies that mean the adapter could not complete the request. */
export const ADAPTER_ERRORS: readonly string[] = [
  "CANERROR",
  "BUFFERFULL",
  "BUSBUSY",
  "BUSERROR",
  "UNABLETOCONNECT",
  "STOPPED",
  "ERROR",
  "FBERROR",
  "DATAERROR",
  "RXERROR",
  "ACTALERT",
  "LVRESET",
  "LPALERT",
];

/** Status lines the adapter prints that carry no data. */
export const NOISE: readonly string[] = ["SEARCHING...", "BUSINIT:OK", "BUSINIT:...OK"];

/** The adapter reported an error or replied with something unreadable. */
export class ElmError extends Error {
  override name = "ElmError";
}

/** The adapter rejected a command this tool depends on. */
export class AdapterUnsupported extends ElmError {
  override name = "AdapterUnsupported";
}

/** The adapter sent the request and no control unit answered. */
export class NoResponse extends ElmError {
  override name = "NoResponse";
}

/** Everything sent to and received from the adapter, in order. */
export class Transcript {
  /** Every line recorded so far, each prefixed with its UTC timestamp and direction. */
  readonly entries: string[] = [];

  /**
   * @param sink Called with each entry as it is recorded, for a platform that persists the
   * transcript (the Node entry point appends it to a file).
   */
  constructor(private readonly sink?: (entry: string) => void) {}

  /** Adds one line; `direction` is `>` for sent and `<` for received. */
  record(direction: string, text: string): void {
    const stamp = new Date().toISOString().replace("Z", "+00:00");
    const entry = `${stamp} ${direction} ${text}`;
    this.entries.push(entry);
    this.sink?.(entry);
  }
}

/** What the adapter says about itself. */
export interface AdapterInfo {
  readonly identity: string;
  readonly description: string | null;
  readonly stnIdentity: string | null;
  readonly voltage: string | null;
  /** Whether the adapter answered the STN identity command, so ST commands exist. */
  readonly hasStnExtensions: boolean;
}

/** One CAN frame as the adapter reports it: its identifier and its data bytes. */
export type IdentifiedFrame = readonly [canId: number, data: Uint8Array];

/**
 * Rebuilds diagnostic messages from CAN frames, per sender.
 *
 * Each frame is a CAN identifier with its data bytes. Returns every complete message each sender
 * sent, in order, keyed by sender in the order each first appeared.
 *
 * @throws ElmError for a frame that does not fit ISO 15765-2 or a multi-frame message cut short.
 */
export function isotpReassemble(frames: readonly IdentifiedFrame[]): Map<number, Uint8Array[]> {
  const complete = new Map<number, Uint8Array[]>();
  const pending = new Map<number, { length: number; buffer: number[] }>();
  const finish = (canId: number, message: Uint8Array): void => {
    const messages = complete.get(canId);
    if (messages === undefined) complete.set(canId, [message]);
    else messages.push(message);
  };
  for (const [canId, data] of frames) {
    const sender = hexNumber(canId, 1);
    if (data.length === 0) throw new ElmError(`empty frame from ${sender}`);
    const first = byteAt(data, 0);
    const kind = first >> 4;
    if (kind === 0) {
      const length = first & 0x0f;
      if (length === 0 || length > data.length - 1) {
        throw new ElmError(`bad single-frame length from ${sender}: ${toHexLower(data)}`);
      }
      finish(canId, data.slice(1, 1 + length));
    } else if (kind === 1) {
      if (data.length < 2)
        throw new ElmError(`short first frame from ${sender}: ${toHexLower(data)}`);
      pending.set(canId, {
        length: ((first & 0x0f) << 8) | byteAt(data, 1),
        buffer: Array.from(data.subarray(2)),
      });
    } else if (kind === 2) {
      const message = pending.get(canId);
      if (message === undefined) {
        throw new ElmError(`continuation frame with no first frame from ${sender}`);
      }
      message.buffer.push(...data.subarray(1));
      if (message.buffer.length >= message.length) {
        finish(canId, Uint8Array.from(message.buffer.slice(0, message.length)));
        pending.delete(canId);
      }
    } else if (kind === 3) {
      // flow control from another tester on the bus
    } else {
      throw new ElmError(`unknown frame type from ${sender}: ${toHexLower(data)}`);
    }
  }
  if (pending.size > 0) {
    const senders = Array.from(pending.keys(), (canId) => hexNumber(canId, 1)).join(", ");
    throw new ElmError(`multi-frame reply cut short from ${senders}`);
  }
  return complete;
}

function toHexLower(data: Uint8Array): string {
  return toUpperHex(data).toLowerCase();
}

function quoted(text: string): string {
  return `'${text}'`;
}

function quotedList(lines: readonly string[]): string {
  return `[${lines.map(quoted).join(", ")}]`;
}

/** Options for an {@link Elm}. */
export interface ElmOptions {
  /** Where the conversation is recorded. Default: a new {@link Transcript} nobody else holds. */
  readonly transcript?: Transcript;
  /**
   * The longest request, in bytes, the link sends as a plain request line. A link that segments in
   * software (a raw CAN link) sets this above {@link MAX_SINGLE_FRAME}. Default: one frame.
   */
  readonly maxRequest?: number;
}

/** One ELM327-style adapter, driven over a transport. */
export class Elm {
  private readonly maxRequest: number;
  private readonly log: Transcript;
  private idBits = 11;
  private stn = false;
  private requestId: number | undefined;
  private extendedAddress: number | undefined;

  constructor(
    private readonly link: Transport,
    options: ElmOptions = {},
  ) {
    this.maxRequest = options.maxRequest ?? MAX_SINGLE_FRAME;
    this.log = options.transcript ?? new Transcript();
  }

  /**
   * The link to the adapter, for the one caller that streams from it instead of exchanging lines.
   */
  get transport(): Transport {
    return this.link;
  }

  /** The record of everything sent to and received from the adapter. */
  get transcript(): Transcript {
    return this.log;
  }

  /**
   * Sends one line and returns the reply lines up to the adapter's prompt, with an echo of the
   * command removed.
   *
   * @param timeoutMs How long to wait for the prompt, in milliseconds.
   * @throws ElmError when no prompt arrives in time.
   */
  async command(text: string, timeoutMs = 5000): Promise<string[]> {
    this.log.record(">", text);
    await this.link.write(asciiEncode(`${text}\r`));
    const chunks: Uint8Array[] = [];
    let sawPrompt = false;
    const deadline = now() + timeoutMs;
    while (!sawPrompt) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new ElmError(`no prompt from the adapter after ${quoted(text)}`);
      let chunk: Uint8Array;
      try {
        chunk = await this.link.read(remaining);
      } catch (error) {
        if (error instanceof TransportTimeout) {
          throw new ElmError(`no prompt from the adapter after ${quoted(text)}`, { cause: error });
        }
        throw error;
      }
      chunks.push(chunk);
      sawPrompt = chunk.includes(PROMPT);
    }
    const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const reply = asciiDecode(all.subarray(0, all.indexOf(PROMPT)));
    let lines = reply
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines[0]?.replaceAll(" ", "").toUpperCase() === text.replaceAll(" ", "").toUpperCase()) {
      lines = lines.slice(1); // the adapter echoed the command
    }
    for (const line of lines) this.log.record("<", line);
    return lines;
  }

  /**
   * Sends a set-up command that must answer OK.
   *
   * @param why The reason given when it does not. Default: the tool needs the full ELM327 command
   * set.
   * @throws AdapterUnsupported when the adapter does not answer OK, naming the command.
   */
  async require(text: string, why?: string): Promise<void> {
    const lines = await this.command(text);
    if (!lines.includes("OK")) {
      const reason =
        why ?? "this tool needs an adapter that implements the full ELM327 command set";
      throw new AdapterUnsupported(
        `the adapter rejected ${text} (replied ${quotedList(lines)}); ${reason}`,
      );
    }
  }

  private async optional(text: string): Promise<string | null> {
    const lines = await this.command(text);
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "?")) return null;
    return lines.join(" ");
  }

  /**
   * Resets the adapter and puts it in the state every request assumes.
   *
   * @throws AdapterUnsupported when the adapter lacks a command this tool depends on.
   */
  async initialise(): Promise<AdapterInfo> {
    const reset = await this.command("ATZ", 10_000);
    await this.require("ATE0"); // no echo
    await this.require("ATL0"); // no line feeds
    await this.require("ATS0"); // no spaces in replies
    await this.require("ATH1"); // show the sender's identifier on every frame
    await this.require("ATCAF1"); // the adapter adds the length byte to requests
    await this.require("ATAT0"); // fixed reply timeout, so a silent unit costs a known wait
    await this.require("ATSTFF"); // the longest reply timeout the adapter offers
    const resetIdentity = reset.join(" ");
    const identity =
      resetIdentity !== "" ? resetIdentity : ((await this.optional("ATI")) ?? "unknown");
    const description = await this.optional("AT@1");
    const stnIdentity = await this.optional("STI");
    const voltage = await this.optional("ATRV");
    this.stn = stnIdentity !== null;
    return { identity, description, stnIdentity, voltage, hasStnExtensions: this.stn };
  }

  /**
   * Selects ISO 15765-4 CAN with the given identifier width and bit rate.
   *
   * 250 and 500 kbit/s use the ELM327 protocols 6 to 9. Any other rate needs either the STN
   * extensions (`STPBR`, checked with `STPBRR`) or, on a plain ELM327, a rate that is 500 kbit/s
   * divided by a whole number from 1 to 64, set through the user-defined protocol B.
   *
   * @throws ElmError for a width or rate no route reaches.
   * @throws AdapterUnsupported when the adapter rejects the command that sets the rate.
   */
  async selectCan(idBits: number, bitrate: number): Promise<void> {
    if (idBits !== 11 && idBits !== 29) {
      throw new ElmError(`CAN identifiers are 11 or 29 bits, not ${String(idBits)}`);
    }
    if (bitrate <= 0) {
      throw new ElmError(`a CAN bit rate must be positive, not ${String(bitrate)}`);
    }
    const protocol = canProtocol(idBits, bitrate);
    if (protocol !== undefined) {
      await this.require(`ATSP${protocol}`);
    } else if (this.stn) {
      await this.selectStnRate(idBits, bitrate);
    } else {
      await this.selectUserProtocol(idBits, bitrate);
    }
    this.idBits = idBits;
  }

  private async selectStnRate(idBits: 11 | 29, bitrate: number): Promise<void> {
    // STPBR sets "current OBD protocol baud rate", so start from the 500 kbit/s protocol of the
    // right identifier width. The manual says it rounds to the closest rate the hardware can
    // generate and clamps out-of-range values without an error, so STPBRR reads back the rate
    // actually set and any difference is refused.
    // Source: OBDLink Family Reference and Programming Manual (FRPM) revision F, "STPBR" and
    // "STPBRR"; https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
    // Unconfirmed on hardware: whether STPBR takes effect before the protocol is opened, and which
    // rates a given adapter's transceiver supports.
    await this.require(`ATSP${BASE_RATE_PROTOCOL[idBits]}`);
    await this.require(
      `STPBR ${String(bitrate)}`,
      "the adapter has STN extensions but would not set that bit rate; the manual does not say which rates each model accepts",
    );
    const lines = await this.command("STPBRR");
    const reported = lines[0];
    if (lines.length !== 1 || reported === undefined || !/^[0-9]+$/.test(reported)) {
      throw new AdapterUnsupported(
        `the adapter did not report its bit rate after STPBRR (replied ${quotedList(lines)})`,
      );
    }
    const actual = Number.parseInt(reported, 10);
    if (actual !== bitrate) {
      throw new ElmError(
        `the adapter set ${String(actual)} bit/s when ${String(bitrate)} bit/s was requested`,
      );
    }
  }

  private async selectUserProtocol(idBits: number, bitrate: number): Promise<void> {
    // A plain ELM327 reaches other rates only through user-defined protocol B: ATPB sets its
    // options byte and baud rate divisor, then ATSPB selects it. The datasheet closes the protocol
    // (ATPC) before sending new values and says they last only until the chip is reset, so every
    // selection sends them.
    // Source: ELM327 datasheet (see USER_PROTOCOL_BASE_RATE), "AT PB", "AT PC" and "AT SP"
    // (protocol B is USER1 CAN, 11-bit ID, 125 kbaud by default).
    // Unconfirmed on hardware: clones that accept ATPB but ignore the divisor.
    const divisor = Math.floor(USER_PROTOCOL_BASE_RATE / bitrate);
    const remainder = USER_PROTOCOL_BASE_RATE % bitrate;
    if (remainder !== 0 || divisor < 1 || divisor > USER_PROTOCOL_MAX_DIVISOR) {
      throw new ElmError(
        `no ELM327 protocol for ${String(idBits)}-bit CAN at ${String(bitrate)} bit/s: a plain ` +
          `ELM327 reaches only ${String(USER_PROTOCOL_BASE_RATE)} bit/s divided by a whole number ` +
          `from 1 to ${String(USER_PROTOCOL_MAX_DIVISOR)}; an adapter with the STN extensions ` +
          "accepts other rates",
      );
    }
    const options = idBits === 11 ? USER_PROTOCOL_ISO15765_11_BIT : USER_PROTOCOL_ISO15765_29_BIT;
    const unsupported =
      "this adapter has no user-defined CAN protocol, so it cannot reach that bit rate";
    await this.require("ATPC", unsupported);
    await this.require(`ATPB ${hexNumber(options, 2)} ${hexNumber(divisor, 2)}`, unsupported);
    await this.require("ATSPB", unsupported);
  }

  /**
   * Sets the transmit header, and with a 29-bit identifier the priority byte, without touching the
   * receive filter or flow control. Requests after this go to `canId`.
   */
  async setHeader(canId: number): Promise<void> {
    this.requestId = canId;
    if (this.idBits === 11) {
      await this.require(`ATSH${hexNumber(canId, 3)}`);
    } else {
      await this.require(`ATCP${hexNumber(Math.floor(canId / 2 ** 24), 2)}`);
      await this.require(`ATSH${hexNumber(canId & 0xffffff, 6)}`);
    }
  }

  private formatId(canId: number): string {
    return hexNumber(canId, this.idBits === 11 ? 3 : 8);
  }

  /**
   * Directs requests to one control unit and accepts replies only from it.
   *
   * @param extendedAddress The unit's ISO 15765-2 extended address, for a unit that is reached
   * with one: the adapter puts it first in every frame it sends, flow control included, and passes
   * only replies that start with {@link EXTENDED_TESTER_ADDRESS}. Absent, extended addressing is
   * off.
   */
  async addressUnit(
    requestId: number,
    responseId: number,
    extendedAddress?: number,
  ): Promise<void> {
    await this.setHeader(requestId);
    await this.require(`ATCRA${this.formatId(responseId)}`);
    // Flow control for multi-frame replies goes back to the unit on its request identifier: send
    // everything, no delay between frames. The adapter does not add the extended address to a flow
    // control frame it builds from AT FC SD, so the data starts with it: the datasheet's extended
    // addressing example sets `AT FC SD 04 30 FF 00` for a unit at address 04.
    // Source: ELM327 datasheet, "Using CAN Extended Addresses".
    await this.require(`ATFCSH${this.formatId(requestId)}`);
    await this.require(
      extendedAddress === undefined
        ? "ATFCSD300000"
        : `ATFCSD${hexNumber(extendedAddress, 2)}300000`,
    );
    await this.require("ATFCSM1");
    await this.setExtendedAddress(extendedAddress);
    if (this.stn) {
      // Transmit segmentation (STPX) waits for the unit's flow-control frame, which the adapter
      // recognises only for a registered (tester identifier, unit identifier) pair; the defaults
      // cover the legislated identifiers only. "Takes two three-digit or eight-digit parameters:
      // txid is transmitter ID (i.e. ID transmitted by the OBDLink), and rxid is receiver ID (i.e.
      // ID transmitted by the ECU)."
      // Source: OBDLink FRPM revision F, "STCFCPA";
      // https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
      await this.require(
        `STCFCPA ${this.formatId(requestId)}, ${this.formatId(responseId)}`,
        "the adapter has STN extensions but would not register the flow-control pair that long requests need",
      );
    }
  }

  /** Broadcasts requests to every emissions-related unit and accepts all replies. */
  async addressFunctional(requestId: number): Promise<void> {
    await this.setHeader(requestId);
    await this.require("ATAR");
    await this.require("ATFCSM0");
    await this.setExtendedAddress(undefined);
  }

  /**
   * Turns CAN extended addressing on with `address`, or off when it is absent. "Off" is sent only
   * when it was on, as it is off after a reset.
   * Source: ELM327 datasheet, "CEA" ("off by default, and once on, can be turned off at any time by
   * sending AT CEA, with no address") and "CEA hh"; added in v1.4 per its version history.
   */
  private async setExtendedAddress(address: number | undefined): Promise<void> {
    if (address !== undefined) {
      await this.require(
        `ATCEA${hexNumber(address, 2)}`,
        "the adapter has no CAN extended addressing (ATCEA, ELM327 v1.4 and later), which this unit needs",
      );
    } else if (this.extendedAddress !== undefined) {
      await this.require("ATCEA");
    }
    this.extendedAddress = address;
  }

  private longRequestCommand(payload: Uint8Array): string {
    if (!this.stn) {
      throw new ElmError(
        `request of ${String(payload.length)} bytes does not fit a single frame, and a plain ` +
          "ELM327 cannot send more than one: its datasheet documents no multi-frame sending " +
          "(only an adapter with the STN extensions can)",
      );
    }
    if (payload.length > MAX_ISOTP_MESSAGE) {
      throw new ElmError(
        `request of ${String(payload.length)} bytes exceeds the ${String(MAX_ISOTP_MESSAGE)} ` +
          "bytes ISO 15765-2 can carry",
      );
    }
    // STPX transmits an arbitrary message; "This command will turn on segmentation but will revert
    // segmentation back to its previous state (on or off) after sending the message", so STCSEGT
    // is never left on. `h` is the CAN identifier and `d` the data bytes without the PCI bytes.
    // With segmentation on the first frame, consecutive frames and the wait for the unit's flow
    // control are the adapter's work; the separation time defaults to the unit's STmin.
    // Source: OBDLink FRPM revision F, "STPX" and "STCSEGT";
    // https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf
    // Unconfirmed on hardware: the longest command line an adapter accepts (the manual's `l:` mode
    // exists for messages longer than the UART buffer, and gives 2 kB or 4 kB maxima by model), and
    // whether `h:` takes an eight-digit identifier for 29-bit CAN. Under extended addressing the
    // `x` parameter carries the address: "ISO 15765: extended address (overrides value, set by
    // ATCEA command)" (FRPM revision F, "STPX"); unconfirmed on hardware.
    const header = this.requestId === undefined ? "" : `h:${this.formatId(this.requestId)}, `;
    const extended =
      this.extendedAddress === undefined ? "" : `, x:${hexNumber(this.extendedAddress, 2)}`;
    return `STPX ${header}d:${toUpperHex(payload)}${extended}`;
  }

  /**
   * Sends one guarded request and returns each sender's reply messages.
   *
   * A request over one frame (more than 7 bytes, or 6 under extended addressing, whose address
   * byte takes one) is sent with the STN `STPX` command, which segments it per ISO 15765-2 and
   * handles the unit's flow control. A plain ELM327 has no documented way to send one, so it
   * refuses. Under extended addressing each reply frame's leading tester address is removed before
   * reassembly.
   *
   * @param timeoutMs How long to wait for the adapter's prompt, in milliseconds.
   * @throws NoResponse when no unit answers.
   * @throws ElmError for an adapter error, an unreadable reply, or a request too long for the
   * adapter or for ISO 15765-2.
   * @throws AdapterUnsupported when an STN adapter rejects STPX.
   */
  async request(permit: Permit, timeoutMs = 8000): Promise<Map<number, Uint8Array[]>> {
    const payload = permit.payload;
    // A link that segments in software (a raw CAN link) takes any length up to its limit as a plain
    // request line; otherwise a request over one frame needs the STN STPX command.
    const extended = this.extendedAddress !== undefined;
    // The extended address takes the first data byte, so a single frame carries one byte less.
    // Source: ELM327 datasheet, "CAN Extended Addresses" ("The remaining seven bytes are used as
    // described previously").
    const singleFrame = extended ? MAX_SINGLE_FRAME - 1 : MAX_SINGLE_FRAME;
    const segmentsInSoftware = this.maxRequest > MAX_SINGLE_FRAME;
    const nativeLong =
      segmentsInSoftware && singleFrame < payload.length && payload.length <= this.maxRequest;
    if (payload.length > this.maxRequest && segmentsInSoftware) {
      throw new ElmError(
        `request of ${String(payload.length)} bytes does not fit ${String(this.maxRequest)} bytes`,
      );
    }
    const longRequest = payload.length > singleFrame && !nativeLong;
    const text = longRequest ? this.longRequestCommand(payload) : toUpperHex(payload);
    const lines = await this.command(text, timeoutMs);
    const idChars = this.idBits === 11 ? 3 : 8;
    const frames: IdentifiedFrame[] = [];
    for (const line of lines) {
      const compact = line.replaceAll(" ", "").toUpperCase();
      if (NOISE.includes(compact)) continue;
      if (compact === "NODATA") throw new NoResponse("no control unit answered");
      if (compact === "?") {
        if (longRequest) {
          throw new AdapterUnsupported(
            "the adapter rejected STPX (replied '?'); " +
              "it has STN extensions but would not send a request over one frame",
          );
        }
        throw new ElmError(`the adapter did not understand ${toUpperHex(payload)}`);
      }
      if (ADAPTER_ERRORS.some((error) => compact.startsWith(error))) {
        throw new ElmError(`adapter error: ${line}`);
      }
      const body = compact.slice(idChars);
      if (
        !/^[0-9A-F]+$/.test(compact) ||
        body.length % 2 !== 0 ||
        body.length < (extended ? 4 : 2) ||
        body.length > 2 * FRAME_BYTES
      ) {
        throw new ElmError(`unreadable reply line: ${quoted(line)}`);
      }
      const data = fromHex(body);
      // With headers on, the adapter prints the extended address after the identifier and before
      // the PCI byte, as Quantex's BMW exchange shows ("610F10662F1500F25F0": "610=CAN ID,
      // F1=tester, 06=length"); https://www.quantexlab.com/en/develop/elm327.html
      if (extended && byteAt(data, 0) !== EXTENDED_TESTER_ADDRESS) {
        throw new ElmError(
          `reply line ${quoted(line)} does not start with the tester address ` +
            hexNumber(EXTENDED_TESTER_ADDRESS, 2),
        );
      }
      frames.push([
        Number.parseInt(compact.slice(0, idChars), 16),
        extended ? data.subarray(1) : data,
      ]);
    }
    if (frames.length === 0) throw new NoResponse("no control unit answered");
    return isotpReassemble(frames);
  }
}
