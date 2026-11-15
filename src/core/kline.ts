/**
 * K-line (ISO 9141-2 and ISO 14230) through an ELM327-style adapter, protocols 3, 4 and 5.
 *
 * The adapter does the wire-level work: the five-baud or fast initialisation, the timing and the
 * checksum. This module selects the protocol, addresses one unit at a time and reads the adapter's
 * replies, which carry a three-byte header, the data and a checksum. Anything about the adapter's
 * exact output that the research notes mark unconfirmed is checked here rather than assumed: a
 * reply whose checksum does not match is refused.
 */

import { byteAt, fromHex, hexNumber, toUpperHex } from "./bytes.js";
import { ADAPTER_ERRORS, Elm, ElmError, MAX_SINGLE_FRAME, NOISE, NoResponse } from "./elm.js";
import type { Permit } from "./guard.js";
import { KLINE_SCHEMES, type KLineBus, type KLineScheme, type Profile } from "./profile.js";
import { pythonRepr } from "./format.js";

/** Time the adapter may take to initialise a bus, in milliseconds: a five-baud address alone takes about two seconds. */
const INIT_TIMEOUT_MS = 20_000;

/** A reply line: three header bytes, at least one data byte, one checksum byte. */
const MIN_REPLY_BYTES = 5;

/** Bytes in the header the adapter prints with `ATH1`: format, target, source. */
const HEADER_BYTES = 3;

/** The schemes that start with a five-baud address, which the adapter needs to be told. */
const SLOW_INIT_SCHEMES: readonly KLineScheme[] = ["iso9141", "kwp2000-slow"];

/** The K-line checksum: the sum of every byte before it, modulo 256. */
export function checksum(data: Uint8Array): number {
  return data.reduce((total, byte) => total + byte, 0) & 0xff;
}

/**
 * Splits one printed K-line reply into its source address and data bytes.
 *
 * @throws ElmError when the line is not whole bytes, is too short or fails its checksum.
 */
export function parseReplyLine(line: string): [source: number, data: Uint8Array] {
  const compact = line.replaceAll(" ", "").toUpperCase();
  if (compact === "" || !/^[0-9A-F]+$/.test(compact) || compact.length % 2 !== 0) {
    throw new ElmError(`unreadable reply line: ${pythonRepr(line)}`);
  }
  const raw = fromHex(compact);
  if (raw.length < MIN_REPLY_BYTES) {
    throw new ElmError(`K-line reply too short: ${pythonRepr(line)}`);
  }
  if (checksum(raw.subarray(0, -1)) !== byteAt(raw, raw.length - 1)) {
    throw new ElmError(`K-line reply fails its checksum: ${pythonRepr(line)}`);
  }
  return [byteAt(raw, 2), raw.slice(HEADER_BYTES, -1)];
}

/**
 * An adapter session on a K-line bus, with the same surface as the CAN session.
 *
 * A unit's request identifier is its K-line address and its response identifier is the address its
 * replies come from. The bus is initialised, for the unit last addressed, on the first request
 * after the address changes.
 */
export class KLineElm extends Elm {
  private bus: KLineBus | undefined;
  private initialised = false;

  /** @throws ElmError always: this session is on a K-line bus, not CAN. */
  override selectCan(): Promise<void> {
    return Promise.reject(new ElmError("this session is on a K-line bus, not CAN"));
  }

  /** Selects the protocol the bus names and stops the adapter searching other protocols. */
  async selectKline(bus: KLineBus): Promise<void> {
    this.bus = bus;
    await this.require(`ATSP${KLINE_SCHEMES[bus.scheme].protocol}`);
    this.initialised = false;
    this.setState({
      bus: {
        kind: "kline",
        scheme: bus.scheme,
        tester: bus.tester,
        headerFormat: bus.headerFormat,
      },
    });
  }

  private selected(): KLineBus {
    if (this.bus === undefined) throw new ElmError("no K-line protocol selected");
    return this.bus;
  }

  /**
   * Directs requests to the unit at K-line address `requestId`.
   *
   * The adapter filters nothing by the reply address, so there is no response identifier to take;
   * callers read the reply by its source address.
   *
   * @throws ElmError when no K-line protocol has been selected.
   */
  override async addressUnit(requestId: number): Promise<void> {
    const bus = this.selected();
    if (SLOW_INIT_SCHEMES.includes(bus.scheme)) {
      await this.require(`ATIIA${hexNumber(requestId, 2)}`);
    }
    await this.require(
      `ATSH${hexNumber(bus.headerFormat, 2)}${hexNumber(requestId, 2)}${hexNumber(bus.tester, 2)}`,
    );
    this.initialised = false;
    this.setState({
      address: { mode: "physical", requestId, responseId: null, extendedAddress: null },
    });
  }

  /**
   * Uses the adapter's default headers, which address every emissions unit.
   *
   * @throws ElmError when no K-line protocol has been selected.
   */
  override addressFunctional(): Promise<void> {
    this.selected();
    this.initialised = false;
    this.setState({ address: { mode: "functional", requestId: null } });
    return Promise.resolve();
  }

  private async initiate(): Promise<void> {
    const bus = this.selected();
    const lines = await this.command(
      SLOW_INIT_SCHEMES.includes(bus.scheme) ? "ATSI" : "ATFI",
      INIT_TIMEOUT_MS,
    );
    const compact = lines.map((line) => line.replaceAll(" ", "").toUpperCase());
    if (!compact.some((line) => line.endsWith("OK"))) {
      throw new NoResponse(`the unit did not answer the initialisation (${lines.join("; ")})`);
    }
    this.initialised = true;
  }

  /**
   * Sends one guarded request and returns each source address's reply messages.
   *
   * @param timeoutMs How long to wait for the adapter's prompt, in milliseconds.
   * @throws NoResponse when the bus cannot be initialised or no unit answers.
   * @throws ElmError for an adapter error, an unreadable reply or a request longer than the adapter
   * sends.
   */
  protected override async send(
    permit: Permit,
    timeoutMs: number,
  ): Promise<Map<number, Uint8Array[]>> {
    const payload = permit.payload;
    if (payload.length > MAX_SINGLE_FRAME) {
      throw new ElmError(
        `request of ${String(payload.length)} bytes is longer than the adapter sends`,
      );
    }
    if (!this.initialised) await this.initiate();
    const lines = await this.command(toUpperHex(payload), timeoutMs);
    const replies = new Map<number, Uint8Array[]>();
    for (const line of lines) {
      const compact = line.replaceAll(" ", "").toUpperCase();
      if (NOISE.includes(compact)) continue;
      if (compact === "NODATA") throw new NoResponse("no control unit answered");
      if (compact === "?") {
        throw new ElmError(`the adapter did not understand ${toUpperHex(payload)}`);
      }
      if (
        compact.startsWith("BUSINIT") ||
        ADAPTER_ERRORS.some((error) => compact.startsWith(error))
      ) {
        throw new ElmError(`adapter error: ${line}`);
      }
      const [source, data] = parseReplyLine(line);
      const messages = replies.get(source) ?? [];
      messages.push(data);
      replies.set(source, messages);
    }
    if (replies.size === 0) throw new NoResponse("no control unit answered");
    return replies;
  }
}

/**
 * Selects the bus a profile names on the adapter session.
 *
 * @throws ElmError when a K-line profile is given a session that is not a {@link KLineElm}.
 */
export async function selectBus(elm: Elm, profile: Profile): Promise<void> {
  const bus = profile.bus;
  if (bus.kind === "can") {
    await elm.selectCan(bus.idBits, bus.bitrate);
  } else if (elm instanceof KLineElm) {
    await elm.selectKline(bus);
  } else {
    throw new ElmError("a K-line profile needs a K-line adapter session");
  }
}
