/**
 * A scripted ELM327 adapter and car: the stand-in the tests use, and the simulator a user can run
 * the tool against without a car.
 *
 * Nothing here talks to hardware. The adapter interprets the AT commands this tool sends and
 * answers diagnostic requests from per-header responders, so the whole tool can be exercised
 * without a car. A platform serves {@link FakeElmCore.feed} over whatever link it has (a TCP
 * socket in Node, an in-process transport in a page).
 */

import { ScriptedTransport } from "./testing/scripted-transport.js";
import { asciiDecode, asciiEncode, concatBytes, fromHex, hexNumber, toUpperHex } from "./bytes.js";
import { DiagProtocol } from "./guard.js";
import type { Profile } from "./profile.js";

/** Takes one request payload and returns (sender identifier, reply payload) pairs. */
export type UnitResponder = (request: Uint8Array) => [number, Uint8Array][];

/** The vehicle identification number the simulated car reports; it belongs to no real car. */
export const SIMULATED_VIN = asciiEncode("SIMULATEDCAR00001");

/** Splits one diagnostic message into ISO 15765-2 CAN frame data. */
export function isotpFrames(payload: Uint8Array): Uint8Array[] {
  if (payload.length <= 7) return [concatBytes(Uint8Array.of(payload.length), payload)];
  const frames = [
    concatBytes(
      Uint8Array.of(0x10 | (payload.length >> 8), payload.length & 0xff),
      payload.slice(0, 6),
    ),
  ];
  let sequence = 1;
  for (let offset = 6; offset < payload.length; offset += 7) {
    frames.push(
      concatBytes(Uint8Array.of(0x20 | (sequence & 0x0f)), payload.slice(offset, offset + 7)),
    );
    sequence += 1;
  }
  return frames;
}

/** Options that change how a {@link FakeElmCore} behaves. */
export interface FakeElmOptions {
  /** Commands the adapter answers with `?`. */
  readonly unsupported?: ReadonlySet<string>;
  readonly identity?: string;
  /** The reply to `STI`; absent means a plain ELM327. */
  readonly stnIdentity?: string;
  /** The granularity the adapter rounds a requested bit rate to. */
  readonly stnRateStep?: number;
}

/** The adapter's command interpreter: feed it bytes, collect what it would send back. */
export class FakeElmCore {
  readonly unsupported: ReadonlySet<string>;
  readonly identity: string;
  readonly stnIdentity: string | undefined;
  readonly sent: string[] = [];
  header = 0;
  idChars = 3;
  readonly longRequests: Uint8Array[] = [];
  /** The (tester identifier, unit identifier) pairs registered with `STCFCPA`. */
  readonly flowControlPairs = new Set<string>();
  baud: number | undefined;
  userOptions = 0xe0;
  userDivisor = 4;
  readonly stnRateStep: number;
  private partial = "";

  constructor(
    public responders: Record<number, UnitResponder>,
    options: FakeElmOptions = {},
  ) {
    this.unsupported = options.unsupported ?? new Set();
    this.identity = options.identity ?? "ELM327 v2.3";
    this.stnIdentity = options.stnIdentity;
    this.stnRateStep = options.stnRateStep ?? 1;
  }

  /** Every line that was a diagnostic request, not an adapter command. */
  get requests(): string[] {
    return this.sent.filter((line) => !line.startsWith("AT") && !line.startsWith("ST"));
  }

  /** Takes the bytes the tool wrote and returns the bytes the adapter would send back. */
  feed(data: Uint8Array): Uint8Array {
    this.partial += asciiDecode(data);
    let output = "";
    let end = this.partial.indexOf("\r");
    while (end >= 0) {
      const line = this.partial.slice(0, end);
      this.partial = this.partial.slice(end + 1);
      output += `${this.handle(line.trim().toUpperCase())}\r\r>`;
      end = this.partial.indexOf("\r");
    }
    return asciiEncode(output);
  }

  private handleStpx(args: string): string {
    // A long request is sent as STN adapters do: segmentation needs a registered flow-control pair.
    if (this.stnIdentity === undefined) return "?";
    const fields = new Map<string, string>();
    for (const part of args.split(",")) {
      const [key, value] = part.trim().split(":");
      if (key !== undefined && value !== undefined) fields.set(key, value);
    }
    const headerText = fields.get("H");
    const header = headerText === undefined ? this.header : Number.parseInt(headerText, 16);
    const payload = fromHex(fields.get("D") ?? "");
    const replies = this.responders[header]?.(payload) ?? [];
    if (replies.length === 0) return "NO DATA";
    const registered = replies.every(([sender]) =>
      this.flowControlPairs.has(`${String(header)}:${String(sender)}`),
    );
    if (!registered) return "FB ERROR"; // no flow control frame was recognised from the unit
    this.longRequests.push(payload);
    return this.frames(replies);
  }

  private frames(replies: [number, Uint8Array][]): string {
    return replies
      .flatMap(([sender, payload]) =>
        isotpFrames(payload).map(
          (frame) => `${hexNumber(sender, this.idChars)}${toUpperHex(frame)}`,
        ),
      )
      .join("\r");
  }

  /** Answers one upper-cased command or request line. */
  protected handle(line: string): string {
    this.sent.push(line);
    if (this.unsupported.has(line)) return "?";
    if (line === "ATZ" || line === "ATI") return this.identity;
    if (line === "AT@1") return "OBDII to RS232 Interpreter";
    if (line === "STI") return this.stnIdentity ?? "?";
    if (line === "ATRV") return "12.4V";
    if (line.startsWith("STCFCPA ")) {
      if (this.stnIdentity === undefined) return "?";
      const [tx, rx] = line
        .slice(8)
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 16));
      this.flowControlPairs.add(`${String(tx)}:${String(rx)}`);
      return "OK";
    }
    if (line.startsWith("STPX ")) return this.handleStpx(line.slice(5));
    if (line.startsWith("ATPB ")) {
      const [options, divisor] = line
        .slice(5)
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 16));
      if (options === undefined || divisor === undefined || divisor < 1 || divisor > 0x40) {
        return "?";
      }
      this.userOptions = options;
      this.userDivisor = divisor;
      return "OK";
    }
    if (line === "ATSPB") {
      this.idChars = (this.userOptions & 0x80) !== 0 ? 3 : 8;
      this.baud = Math.floor(500_000 / this.userDivisor);
      return "OK";
    }
    if (line.startsWith("STPBR ")) {
      if (this.stnIdentity === undefined) return "?";
      // The adapter rounds to a rate it can generate, as the STN manual describes.
      const requested = Number.parseInt(line.slice(6), 10);
      this.baud = Math.round(requested / this.stnRateStep) * this.stnRateStep;
      return "OK";
    }
    if (line === "STPBRR") return this.baud === undefined ? "?" : String(this.baud);
    if (line.startsWith("ATSP")) {
      const protocol = line.slice(4);
      this.baud = { "6": 500_000, "7": 500_000, "8": 250_000, "9": 250_000 }[protocol];
      this.idChars = protocol === "7" || protocol === "9" ? 8 : 3;
      return "OK";
    }
    if (line.startsWith("ATSH")) {
      this.header = Number.parseInt(line.slice(4), 16);
      return "OK";
    }
    if (line.startsWith("AT") || line.startsWith("ST")) return "OK";
    const replies = this.responders[this.header]?.(fromHex(line)) ?? [];
    if (replies.length === 0) return "NO DATA";
    return this.frames(replies);
  }
}

/** A KWP2000 control unit with stored fault codes, for one response identifier. */
export class KwpEcu {
  faults: [number, number][];
  readonly ident = concatBytes(Uint8Array.of(0x86), asciiEncode("A6421500000 E280CDI"));
  freezeRefused = false;
  readonly records = new Map<number, Uint8Array>();
  writesRefused = false;
  readonly actuations: Uint8Array[] = [];

  constructor(
    readonly responseId: number,
    faults: readonly [number, number][],
  ) {
    this.faults = faults.map(([code, status]) => [code, status]);
  }

  /** The responder for this unit: every request gets one reply from {@link responseId}. */
  readonly respond: UnitResponder = (request) => [[this.responseId, this.reply(request)]];

  private reply(request: Uint8Array): Uint8Array {
    const [service = 0, first = 0] = request;
    if (service === 0x10) return Uint8Array.of(0x50, first);
    if (service === 0x1a) return concatBytes(Uint8Array.of(0x5a), this.ident);
    if (service === 0x18) {
      const body = this.faults.flatMap(([code, status]) => [code >> 8, code & 0xff, status]);
      return Uint8Array.of(0x58, this.faults.length, ...body);
    }
    if (service === 0x12) {
      if (this.freezeRefused) return Uint8Array.of(0x7f, 0x12, 0x11);
      return concatBytes(
        Uint8Array.of(0x52, 0x01),
        request.slice(3, 5),
        Uint8Array.of(0x0c, 0x8a, 0x31),
      );
    }
    if (service === 0x14) {
      this.faults = [];
      return Uint8Array.of(0x54, 0xff, 0x00);
    }
    if (service === 0x21 && request.length === 2) {
      const record = this.records.get(first);
      if (record === undefined) return Uint8Array.of(0x7f, service, 0x31);
      return concatBytes(Uint8Array.of(0x61, first), record);
    }
    if (service === 0x3b && request.length > 2 && this.records.has(first)) {
      if (this.writesRefused) return Uint8Array.of(0x7f, service, 0x22);
      this.records.set(first, request.slice(2));
      return Uint8Array.of(0x7b, first);
    }
    if (service === 0x30 && request.length >= 2) {
      this.actuations.push(request);
      return concatBytes(Uint8Array.of(0x70), request.slice(1));
    }
    if (service === 0x3e) return Uint8Array.of(0x7e);
    return Uint8Array.of(0x7f, service, 0x11);
  }
}

/** A UDS control unit with stored fault codes (three code bytes and a status byte each). */
export class UdsEcu {
  faults: [number, number][];
  readonly records = new Map<number, Uint8Array>([[0xf190, SIMULATED_VIN]]);
  writesRefused = false;
  readonly actuations: Uint8Array[] = [];

  constructor(
    readonly responseId: number,
    faults: readonly [number, number][],
  ) {
    this.faults = faults.map(([code, status]) => [code, status]);
  }

  /** The responder for this unit: every request gets one reply from {@link responseId}. */
  readonly respond: UnitResponder = (request) => [[this.responseId, this.reply(request)]];

  private reply(request: Uint8Array): Uint8Array {
    const [service = 0, first = 0, second = 0] = request;
    const identifier = (first << 8) | second;
    if (service === 0x10) return Uint8Array.of(0x50, first, 0x00, 0x32, 0x01, 0xf4);
    if (service === 0x22) {
      const record = this.records.get(identifier);
      if (request.length !== 3 || record === undefined) return Uint8Array.of(0x7f, service, 0x31);
      return concatBytes(Uint8Array.of(0x62), request.slice(1, 3), record);
    }
    if (service === 0x2e && request.length > 3) {
      if (!this.records.has(identifier)) return Uint8Array.of(0x7f, service, 0x31);
      if (this.writesRefused) return Uint8Array.of(0x7f, service, 0x22);
      this.records.set(identifier, request.slice(3));
      return concatBytes(Uint8Array.of(0x6e), request.slice(1, 3));
    }
    if (service === 0x2f && request.length >= 4) {
      this.actuations.push(request);
      return concatBytes(Uint8Array.of(0x6f), request.slice(1));
    }
    if (service === 0x19 && first === 0x02) {
      const records = this.faults.flatMap(([code, status]) => [
        (code >> 16) & 0xff,
        (code >> 8) & 0xff,
        code & 0xff,
        status,
      ]);
      return Uint8Array.of(0x59, 0x02, 0xff, ...records);
    }
    if (service === 0x19 && first === 0x04) {
      const wanted = (second << 16) | ((request[3] ?? 0) << 8) | (request[4] ?? 0);
      const fault = this.faults.find(([code]) => code === wanted);
      if (fault === undefined) return Uint8Array.of(0x7f, service, 0x31);
      return concatBytes(
        Uint8Array.of(0x59, 0x04),
        request.slice(2, 5),
        Uint8Array.of(fault[1], 0x01, 0x01),
      );
    }
    if (service === 0x14) {
      this.faults = [];
      return Uint8Array.of(0x54);
    }
    if (service === 0x3e) return Uint8Array.of(0x7e, 0x00);
    return Uint8Array.of(0x7f, service, 0x11);
  }
}

/** The functional request identifier legislated OBD-II requests are broadcast to, 11-bit. */
export const FUNCTIONAL_REQUEST_ID = 0x7df;

const OBD_REPLIES: ReadonlyMap<string, Uint8Array> = new Map([
  ["0902", concatBytes(Uint8Array.of(0x49, 0x02, 0x01), SIMULATED_VIN)],
  ["0101", fromHex("410181000000")],
  ["03", fromHex("43010420")],
  ["07", fromHex("4700")],
]);

/** The legislated OBD-II reads a simulated engine unit answers: VIN and stored codes. */
export function obdResponder(request: Uint8Array): [number, Uint8Array][] {
  const reply = OBD_REPLIES.get(toUpperHex(request));
  return reply === undefined ? [] : [[0x7e8, reply]];
}

/**
 * The one fault every simulated KWP2000 unit holds, so reads, freeze frames and clears have
 * something to show. The bytes are invented and mean nothing on a real car.
 */
export const SIMULATED_KWP_FAULT: readonly [code: number, status: number] = [0x1234, 0x20];

/** The one fault every simulated UDS unit holds. Invented, like {@link SIMULATED_KWP_FAULT}. */
export const SIMULATED_UDS_FAULT: readonly [code: number, status: number] = [0xc12345, 0x08];

/**
 * The one writable record every simulated KWP2000 unit holds, so `write` and `restore` can be
 * tried: a local identifier and its value. Invented.
 */
export const SIMULATED_KWP_RECORD: readonly [identifier: number, value: Uint8Array] = [
  0x99,
  Uint8Array.of(0x00, 0x01),
];

/** The one writable record every simulated UDS unit holds: a data identifier and its value. */
export const SIMULATED_UDS_RECORD: readonly [identifier: number, value: Uint8Array] = [
  0x0199,
  Uint8Array.of(0x00, 0x01),
];

/**
 * A fresh adapter wired to one scripted unit per profile unit, plus OBD-II on the functional
 * identifier. Each call returns a car untouched by any other.
 */
export function simulatedCar(profile: Pick<Profile, "protocol" | "units">): FakeElmCore {
  const responders: Record<number, UnitResponder> = { [FUNCTIONAL_REQUEST_ID]: obdResponder };
  for (const unit of profile.units.values()) {
    if (profile.protocol === DiagProtocol.UDS) {
      const uds = new UdsEcu(unit.responseId, [[...SIMULATED_UDS_FAULT]]);
      uds.records.set(SIMULATED_UDS_RECORD[0], SIMULATED_UDS_RECORD[1]);
      responders[unit.requestId] = uds.respond;
    } else {
      const kwp = new KwpEcu(unit.responseId, [[...SIMULATED_KWP_FAULT]]);
      kwp.records.set(SIMULATED_KWP_RECORD[0], SIMULATED_KWP_RECORD[1]);
      responders[unit.requestId] = kwp.respond;
    }
  }
  return new FakeElmCore(responders);
}

/** An in-process adapter link backed by `core`. */
export function adapterTransport(core: FakeElmCore): ScriptedTransport {
  return new ScriptedTransport((written) => core.feed(written));
}

/** A link to a fresh {@link simulatedCar} of the profile, for use without a car or a server. */
export function simulatedTransport(
  profile: Pick<Profile, "protocol" | "units">,
): ScriptedTransport {
  return adapterTransport(simulatedCar(profile));
}

/**
 * The two lines the `simulate` command prints once a platform is listening for adapter
 * connections at `host` and `port`, each of which gets its own {@link simulatedCar}.
 */
export function simulationBanner(
  profile: Pick<Profile, "name" | "units">,
  host: string,
  port: number,
): [string, string] {
  return [
    `simulating ${profile.name} (${String(profile.units.size)} units) on tcp://${host}:${String(port)}`,
    "each connection gets a fresh car; press Ctrl-C to stop",
  ];
}
