/** Legislated OBD-II (SAE J1979) reads, which work on any compliant car without a profile. */

import { byteAt, hexNumber, toHex } from "./bytes.js";
import { ElmError, NoResponse, type Elm } from "./elm.js";
import { formatSignificant } from "./format.js";
import { DiagProtocol, permit } from "./guard.js";

/** Functional request identifiers every emissions-related unit listens on, by identifier width. */
export const FUNCTIONAL_ID: Readonly<Record<11 | 29, number>> = { 11: 0x7df, 29: 0x18db33f1 };

export const CURRENT_DATA = 0x01;
export const FREEZE_FRAME = 0x02;
export const STORED_CODES = 0x03;
export const PENDING_CODES = 0x07;
export const MONITORING_RESULTS = 0x06;
export const VEHICLE_INFORMATION = 0x09;
export const PERMANENT_CODES = 0x0a;

export const PID_MONITOR_STATUS = 0x01;
export const PID_FREEZE_FRAME_CODE = 0x02;
export const FRAME_NUMBER = 0x00;
export const INFO_VIN = 0x02;

const POSITIVE_OFFSET = 0x40;

// Mode 06 misfire monitors: the first is for the engine as a whole, the next ones are per cylinder
// in monitor order.
export const MISFIRE_GENERAL = 0xa1;
export const MISFIRE_FIRST_CYLINDER = 0xa2;
export const MISFIRE_LAST_CYLINDER = 0xad;
// Misfire test identifiers. Their meaning here is GM's published data definition and a Saab service
// table, not a legislated one, so a caller shows them as unconfirmed for a given maker.
/** Average over the last ten driving cycles. */
export const TID_MISFIRE_AVERAGE = 0x0b;
/** Count for the last or current driving cycle. */
export const TID_MISFIRE_LATEST = 0x0c;
/** Bytes in one mode 06 entry: monitor, test, unit and scaling, value, minimum, maximum. */
export const MONITOR_ENTRY_LENGTH = 9;

const CODE_LETTERS = "PCBU";

/** One current-data parameter that freeze frames and the live loop decode directly. */
export interface LiveValue {
  readonly label: string;
  readonly unit: string;
  readonly size: number;
  readonly decode: (data: Uint8Array) => number;
}

function word(data: Uint8Array): number {
  return byteAt(data, 0) * 256 + byteAt(data, 1);
}

/** The values a freeze frame reports, by parameter identifier. */
export const LIVE_VALUES: ReadonlyMap<number, LiveValue> = new Map([
  [0x04, { label: "engine load", unit: "%", size: 1, decode: (d) => (byteAt(d, 0) * 100) / 255 }],
  [0x05, { label: "coolant temperature", unit: "°C", size: 1, decode: (d) => byteAt(d, 0) - 40 }],
  [0x0b, { label: "intake manifold pressure", unit: "kPa", size: 1, decode: (d) => byteAt(d, 0) }],
  [0x0c, { label: "engine speed", unit: "rpm", size: 2, decode: (d) => word(d) / 4 }],
  [0x0d, { label: "vehicle speed", unit: "km/h", size: 1, decode: (d) => byteAt(d, 0) }],
  [
    0x0f,
    { label: "intake air temperature", unit: "°C", size: 1, decode: (d) => byteAt(d, 0) - 40 },
  ],
  [0x42, { label: "control module voltage", unit: "V", size: 2, decode: (d) => word(d) / 1000 }],
]);

/** One unit's warning-lamp state and stored-code count. */
export interface Readiness {
  readonly lampOn: boolean;
  readonly codeCount: number;
}

/** Turns two bytes into a standard fault code such as P0420. */
export function decodeCode(pair: Uint8Array): string {
  const first = byteAt(pair, 0);
  const letter = CODE_LETTERS[first >> 6] ?? "";
  return `${letter}${((first >> 4) & 0x3).toString(16).toUpperCase()}${(first & 0xf)
    .toString(16)
    .toUpperCase()}${hexNumber(byteAt(pair, 1), 2)}`;
}

/**
 * Sends one request and returns each answering unit's positive reply, keyed by the unit's
 * identifier.
 *
 * A request no unit answers returns an empty result: a car is free to support only some of the
 * legislated reads. Every legislated read goes through here, so each passes the guard.
 *
 * @throws GuardError when the request is not a read-only OBD service.
 */
export async function readAnswers(elm: Elm, payload: Uint8Array): Promise<Map<number, Uint8Array>> {
  let replies: Map<number, Uint8Array[]>;
  try {
    replies = await elm.request(await permit(DiagProtocol.OBD, payload));
  } catch (error) {
    if (error instanceof NoResponse) return new Map();
    throw error;
  }
  const answers = new Map<number, Uint8Array>();
  for (const [sender, messages] of replies) {
    for (const message of messages) {
      if (message[0] === byteAt(payload, 0) + POSITIVE_OFFSET) answers.set(sender, message);
    }
  }
  return answers;
}

/**
 * Reads fault codes of one kind (stored, pending or permanent) from every unit.
 *
 * @throws ElmError when a reply's length does not match the count it declares.
 */
export async function codes(elm: Elm, mode: number): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  for (const [sender, message] of await readAnswers(elm, Uint8Array.of(mode))) {
    const count = byteAt(message, 1);
    const body = message.slice(2);
    if (body.length < 2 * count) {
      throw new ElmError(
        `unit ${hexNumber(sender, 1)} declares ${String(count)} codes but sent ${toHex(body)}`,
      );
    }
    const found: string[] = [];
    for (let index = 0; index < 2 * count; index += 2) {
      found.push(decodeCode(body.slice(index, index + 2)));
    }
    result.set(sender, found);
  }
  return result;
}

/** Reads each unit's warning-lamp state and stored-code count. */
export async function readiness(elm: Elm): Promise<Map<number, Readiness>> {
  const answers = await readAnswers(elm, Uint8Array.of(CURRENT_DATA, PID_MONITOR_STATUS));
  const result = new Map<number, Readiness>();
  for (const [sender, message] of answers) {
    if (message.length < 3) continue;
    const status = byteAt(message, 2);
    result.set(sender, { lampOn: (status & 0x80) !== 0, codeCount: status & 0x7f });
  }
  return result;
}

/** Reads the vehicle identification number, or `undefined` when no unit reports one. */
export async function vin(elm: Elm): Promise<string | undefined> {
  const answers = await readAnswers(elm, Uint8Array.of(VEHICLE_INFORMATION, INFO_VIN));
  for (const message of answers.values()) {
    const text = Array.from(message.slice(3))
      .filter((byte) => byte > 0x20 && byte < 0x7f)
      .map((byte) => String.fromCharCode(byte))
      .join("");
    if (text !== "") return text;
  }
  return undefined;
}

/** The fault code a unit froze its data for, and the live values stored with it. */
export interface FreezeFrame {
  /** The frozen fault code, or `null` when the unit reports none. */
  readonly code: string | null;
  /** The stored values by label, as text with the unit. */
  readonly values: Map<string, string>;
}

/**
 * Reads the freeze frame each unit stored with its first fault code.
 *
 * A unit with no freeze frame, or one that does not answer, is left out.
 */
export async function freezeFrame(elm: Elm): Promise<Map<number, FreezeFrame>> {
  const frames = new Map<number, FreezeFrame>();
  const request = Uint8Array.of(FREEZE_FRAME, PID_FREEZE_FRAME_CODE, FRAME_NUMBER);
  for (const [sender, message] of await readAnswers(elm, request)) {
    if (message.length < 5) continue;
    const pair = message.slice(3, 5);
    const frozen = byteAt(pair, 0) !== 0 || byteAt(pair, 1) !== 0;
    frames.set(sender, { code: frozen ? decodeCode(pair) : null, values: new Map() });
  }
  for (const [pid, value] of LIVE_VALUES) {
    const answers = await readAnswers(elm, Uint8Array.of(FREEZE_FRAME, pid, FRAME_NUMBER));
    for (const [sender, message] of answers) {
      const data = message.slice(3);
      const frame = frames.get(sender);
      if (frame !== undefined && data.length >= value.size) {
        frame.values.set(value.label, `${formatSignificant(value.decode(data), 6)} ${value.unit}`);
      }
    }
  }
  return frames;
}

/** One misfire monitor's counts, keyed by test identifier. */
export interface MisfireCounts {
  readonly monitor: number;
  readonly averageLastTenCycles: number | undefined;
  readonly lastCycle: number | undefined;
}

/** Picks the average and latest counts out of one monitor's reply, ignoring other tests. */
function monitorCounts(monitor: number, message: Uint8Array): MisfireCounts {
  const counts = new Map<number, number>();
  const body = message.slice(1);
  for (let start = 0; start + MONITOR_ENTRY_LENGTH <= body.length; start += MONITOR_ENTRY_LENGTH) {
    const entry = body.slice(start, start + MONITOR_ENTRY_LENGTH);
    if (byteAt(entry, 0) === monitor) {
      counts.set(byteAt(entry, 1), byteAt(entry, 3) * 256 + byteAt(entry, 4));
    }
  }
  return {
    monitor,
    averageLastTenCycles: counts.get(TID_MISFIRE_AVERAGE),
    lastCycle: counts.get(TID_MISFIRE_LATEST),
  };
}

/**
 * Reads the misfire monitors from every unit: the whole engine first, then each cylinder.
 *
 * Cylinder monitors are read until the first one a unit does not report.
 */
export async function misfireCounts(elm: Elm): Promise<Map<number, MisfireCounts[]>> {
  const result = new Map<number, MisfireCounts[]>();
  for (let monitor = MISFIRE_GENERAL; monitor <= MISFIRE_LAST_CYLINDER; monitor++) {
    const answers = await readAnswers(elm, Uint8Array.of(MONITORING_RESULTS, monitor));
    if (answers.size === 0 && monitor !== MISFIRE_GENERAL) break;
    for (const [sender, message] of answers) {
      const list = result.get(sender) ?? [];
      list.push(monitorCounts(monitor, message));
      result.set(sender, list);
    }
  }
  return result;
}
