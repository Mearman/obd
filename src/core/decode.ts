/**
 * The decode layer: a capture's raw exchanges turned into the reports the commands print, under a vehicle profile or under none.
 *
 * {@link decodeCapture} is deterministic and touches nothing outside its arguments: it replays the capture through the same readers a live session uses (`readUnit`, the legislated reads, `obdReport`), on a {@link ReplayElm}, so a report decoded from a capture is the report the live read would have printed. The same capture decodes under any profile, a changed or newer version of one, or with none. Every exchange no reader used is returned in {@link DecodedCapture.undecoded} with its raw bytes, never dropped.
 *
 * The live commands use the same readers through `readThroughCapture` (`captured-read.ts`), so what they print is what their own capture decodes to. This module is platform-free.
 */

import { fromHex, hexNumber } from "./bytes.js";
import type { Capture } from "./capture.js";
import { NegativeResponse, RESPONSE_CODES } from "./diag.js";
import { interpret, type Found } from "./discovery.js";
import { ElmError, type LinkState } from "./elm.js";
import {
  addressKey,
  busesCompatible,
  describeAddress,
  type Exchange,
  type ExchangeAddress,
  type ExchangeBus,
} from "./exchange.js";
import { DiagProtocol } from "./guard.js";
import { obdReport } from "./obd-report.js";
import { readAddressedObdScan, type ObdScan } from "./obd-scan.js";
import { printUnit, readUnit, type ReadOptions, type UnitReport } from "./operations.js";
import { decodeValue, isReadOnlySession, type Profile, type Unit } from "./profile.js";
import { ReplayElm } from "./replay.js";
import { makeClient } from "./unit-access.js";

/** What a capture is decoded with: a vehicle profile, or none (the legislated OBD-II reads only). */
export type DecodeTarget =
  { readonly kind: "profile"; readonly profile: Profile } | { readonly kind: "generic" };

/** One named value of a profile, read from an exchange in the capture. */
export interface DecodedValue {
  /** The unit (control unit) the value belongs to. */
  readonly unit: string;
  /** The value's name in the profile. */
  readonly name: string;
  readonly label: string;
  /** The unit of measure; empty for none. */
  readonly measure: string;
  /** The number, or why the reply could not be decoded. */
  readonly value: number | { readonly error: string };
  /** The sequence number of the exchange it came from. */
  readonly seq: number;
}

/** What a capture says under one profile or none. */
export interface DecodedCapture {
  /** The profile decoded with, or `null` for none. */
  readonly profile: { readonly name: string; readonly status: string } | null;
  /** One report per unit of the profile, in profile order; empty with no profile. */
  readonly units: readonly UnitReport[];
  /** The legislated OBD-II reads, or `null` when the capture holds none. */
  readonly obd: ObdScan | null;
  /** The legislated reads as the `obd` command prints them; empty when the capture holds none. */
  readonly obdLines: readonly string[];
  /** The profile's named values the capture holds a read for. */
  readonly values: readonly DecodedValue[];
  /** Units that answered a discovery sweep's session request. */
  readonly discovered: readonly Found[];
  /** Every exchange no reader used, in capture order, raw. */
  readonly undecoded: readonly Exchange[];
  /** How many exchanges the capture holds. */
  readonly exchanges: number;
}

/** The request that reads a unit's fault codes, and the prefix of a freeze-frame read, per protocol, as upper-case hexadecimal. */
const READS: Readonly<
  Record<"kwp2000" | "uds", { readonly faults: string; readonly freeze: string }>
> = {
  [DiagProtocol.KWP2000]: { faults: "1802FF00", freeze: "12" },
  [DiagProtocol.UDS]: { faults: "1902FF", freeze: "1904" },
};

/** The bus a profile's units are on, as an exchange records one. */
function profileBus(profile: Profile): ExchangeBus {
  return profile.bus.kind === "can"
    ? { kind: "can", idBits: profile.bus.idBits, bitrate: profile.bus.bitrate }
    : {
        kind: "kline",
        scheme: profile.bus.scheme,
        tester: profile.bus.tester,
        headerFormat: profile.bus.headerFormat,
      };
}

/** The bus one unit of a profile is read on: the profile's, at the unit's own identifier width when it gives one. */
function unitBus(profile: Profile, unit: Unit): ExchangeBus {
  const bus = profileBus(profile);
  return bus?.kind === "can" && unit.idBits !== undefined ? { ...bus, idBits: unit.idBits } : bus;
}

/** The address a profile's unit is read at. */
function unitAddress(profile: Profile, unit: Unit): ExchangeAddress {
  return {
    mode: "physical",
    requestId: unit.requestId,
    responseId: profile.bus.kind === "kline" ? null : unit.responseId,
    extendedAddress: unit.extendedAddress ?? null,
  };
}

/** The exchanges at `address` on a bus compatible with `bus`. */
function exchangesAt(capture: Capture, address: ExchangeAddress, bus: ExchangeBus): Exchange[] {
  const key = addressKey(address);
  return capture.exchanges.filter(
    (exchange) => addressKey(exchange.address) === key && busesCompatible(bus, exchange.bus),
  );
}

/** A report for a unit the capture holds nothing for. */
function absentUnit(unit: Unit): UnitReport {
  return {
    unit: unit.name,
    description: unit.description,
    requestId: hexNumber(unit.requestId, 1),
    responseId: hexNumber(unit.responseId, 1),
    answered: false,
    notes: ["not in this capture"],
    identification: new Map(),
    faults: null,
    freezeFrames: new Map(),
  };
}

/** Decodes one unit of the profile from the capture, recording the exchanges used in `served`. */
async function decodeUnit(
  capture: Capture,
  profile: Profile,
  unit: Unit,
  served: Set<number>,
): Promise<UnitReport> {
  const address = unitAddress(profile, unit);
  const held = exchangesAt(capture, address, unitBus(profile, unit));
  if (held.length === 0) return absentUnit(unit);
  const reads = READS[unit.protocol];
  const sessionRequest = `10${hexNumber(unit.session, 2)}`;
  // Another session the capture opened stands in only when the profile's protocol may open it too.
  const opened = held.find(
    (exchange) =>
      exchange.request.startsWith("10") &&
      exchange.request.length === 4 &&
      isReadOnlySession(unit.protocol, Number.parseInt(exchange.request.slice(2), 16)),
  );
  let session = unit.session;
  const notes: string[] = [];
  if (!held.some((exchange) => exchange.request === sessionRequest) && opened !== undefined) {
    session = Number.parseInt(opened.request.slice(2), 16);
    notes.push(
      `decoded with the session the capture opened (10 ${opened.request.slice(2)}), not the profile's (10 ${hexNumber(unit.session, 2)})`,
    );
  }
  const options: ReadOptions = {
    faults: held.some((exchange) => exchange.request === reads.faults),
    freeze: held.some((exchange) => exchange.request.startsWith(reads.freeze)),
  };
  const replay = new ReplayElm(capture.exchanges, { bus: profileBus(profile), address: null });
  const report = await readUnit(replay, profile, { ...unit, session }, options);
  for (const seq of replay.served) served.add(seq);
  report.notes.push(...notes);
  return report;
}

/** The request that reads a value's identifier, as upper-case hexadecimal. */
function valueRequest(protocol: Profile["protocol"], identifier: number): string {
  return protocol === DiagProtocol.UDS
    ? `22${hexNumber(identifier, 4)}`
    : `21${hexNumber(identifier, 2)}`;
}

/** Decodes the profile's named values the capture holds a read for. */
async function decodeValues(
  capture: Capture,
  profile: Profile,
  served: Set<number>,
): Promise<DecodedValue[]> {
  const values: DecodedValue[] = [];
  for (const unit of profile.units.values()) {
    const address = unitAddress(profile, unit);
    const bus = unitBus(profile, unit);
    for (const value of unit.values.values()) {
      const replay = new ReplayElm(capture.exchanges, { bus, address });
      if (!replay.holds(address, valueRequest(unit.protocol, value.identifier))) continue;
      let decoded: DecodedValue["value"];
      try {
        decoded = decodeValue(
          value,
          await makeClient(replay, profile, unit).readValue(value.identifier),
        );
      } catch (error) {
        if (!(
          error instanceof ElmError ||
          error instanceof NegativeResponse ||
          error instanceof RangeError
        )) {
          throw error;
        }
        decoded = { error: error.message };
      }
      const [seq] = replay.served;
      if (seq === undefined) continue;
      served.add(seq);
      values.push({
        unit: unit.name,
        name: value.name,
        label: value.label,
        measure: value.unit,
        value: decoded,
        seq,
      });
    }
  }
  return values;
}

/** The units that answered a sweep's session requests, from the capture's any-reply exchanges. */
function decodeDiscovery(capture: Capture, served: Set<number>): Found[] {
  const found: Found[] = [];
  for (const exchange of capture.exchanges) {
    const { address, outcome } = exchange;
    if (address?.mode !== "any-reply" || !exchange.request.startsWith("10")) continue;
    served.add(exchange.seq);
    if (outcome.kind !== "replies") continue;
    const replies = new Map(
      outcome.replies.map(({ sender, messages }) => [sender, messages.map((hex) => fromHex(hex))]),
    );
    found.push(...interpret(replies, address.requestId));
  }
  return found;
}

/** The bus and address of the capture's first broadcast, where its legislated reads were made, or `undefined` when it holds none. */
function broadcastState(capture: Capture): LinkState | undefined {
  const first = capture.exchanges.find((exchange) => exchange.address?.mode === "functional");
  return first === undefined ? undefined : { bus: first.bus, address: first.address };
}

/** Decodes the legislated reads, as structured data and as the `obd` command's lines. */
async function decodeLegislated(
  capture: Capture,
  served: Set<number>,
): Promise<{ readonly obd: ObdScan | null; readonly lines: string[] }> {
  const state = broadcastState(capture);
  if (state === undefined) return { obd: null, lines: [] };
  const lines: string[] = [];
  const printed = new ReplayElm(capture.exchanges, state);
  await obdReport(printed, (line) => lines.push(line));
  const structured = new ReplayElm(capture.exchanges, state);
  const obd = await readAddressedObdScan(structured);
  for (const seq of [...printed.served, ...structured.served]) served.add(seq);
  return { obd, lines };
}

/**
 * Decodes a capture under a profile or under none.
 *
 * With a profile, every unit of the profile is decoded from the exchanges at its address on the profile's bus, at the unit's own identifier width, with the unit's own protocol and session: a unit the capture holds nothing for is reported as not in the capture, and a unit whose session request differs from the profile's is decoded with the session the capture opened, with a note saying so, when that session is one the unit's protocol may open. The profile's named values are decoded wherever the capture holds a read of their identifier. In both cases the legislated reads are decoded when the capture holds a broadcast, and the units that answered a discovery sweep are listed. Every other exchange is returned undecoded.
 *
 * The result depends only on the capture and the target: decoding twice gives equal results.
 */
export async function decodeCapture(
  capture: Capture,
  target: DecodeTarget,
): Promise<DecodedCapture> {
  const served = new Set<number>();
  const units: UnitReport[] = [];
  let values: DecodedValue[] = [];
  if (target.kind === "profile") {
    for (const unit of target.profile.units.values()) {
      units.push(await decodeUnit(capture, target.profile, unit, served));
    }
    values = await decodeValues(capture, target.profile, served);
  }
  const legislated = await decodeLegislated(capture, served);
  const discovered = decodeDiscovery(capture, served);
  return {
    profile:
      target.kind === "profile"
        ? { name: target.profile.name, status: target.profile.status }
        : null,
    units,
    obd: legislated.obd,
    obdLines: legislated.lines,
    values,
    discovered,
    undecoded: capture.exchanges.filter((exchange) => !served.has(exchange.seq)),
    exchanges: capture.exchanges.length,
  };
}

/** One exchange's outcome in a line: each sender's messages, a negative response's meaning, or the failure. */
export function describeOutcome(exchange: Exchange): string {
  const { outcome } = exchange;
  switch (outcome.kind) {
    case "replies":
      return outcome.replies
        .map(({ sender, messages }) => {
          const shown = messages.map((message) => {
            if (!message.startsWith("7F") || message.length < 6) return message;
            const code = Number.parseInt(message.slice(4, 6), 16);
            return `${message} (refused: ${RESPONSE_CODES.get(code) ?? "manufacturer-specific or unlisted reason"})`;
          });
          return `${hexNumber(sender, 1)} ${shown.join(" ")}`;
        })
        .join("; ");
    case "no-response":
      return "no answer";
    case "adapter-error":
      return `adapter error: ${outcome.message}`;
    case "transport-error":
      return `link failed: ${outcome.message}`;
  }
}

/** One undecoded exchange as a report line. */
export function undecodedLine(exchange: Exchange): string {
  return `#${String(exchange.seq)} ${describeAddress(exchange.address)} ${exchange.request}: ${describeOutcome(exchange)}`;
}

/**
 * A decoded capture as the commands print it: the scan's unit lines under a profile, the `obd` command's lines for the legislated reads, then the named values, the units a sweep found and every undecoded exchange.
 */
export function decodedLines(decoded: DecodedCapture): string[] {
  const lines: string[] = [];
  if (decoded.profile === null) {
    lines.push("decoded with no profile: the legislated OBD-II reads only");
  } else {
    lines.push(`decoded with profile ${decoded.profile.name}`);
    if (decoded.profile.status !== "confirmed") {
      lines.push(`profile ${decoded.profile.name}: address table is ${decoded.profile.status}`);
    }
    for (const unit of decoded.units) printUnit(unit, (line) => lines.push(line));
    const answered = decoded.units.filter((unit) => unit.answered).length;
    lines.push(`${String(answered)} of ${String(decoded.units.length)} units answered`);
  }
  lines.push(...decoded.obdLines);
  if (decoded.values.length > 0) lines.push("values:");
  for (const value of decoded.values) {
    const shown =
      typeof value.value === "number"
        ? `${String(value.value)} ${value.measure}`.trimEnd()
        : `not decoded (${value.value.error})`;
    lines.push(`  ${value.unit} ${value.label}: ${shown}`);
  }
  if (decoded.discovered.length > 0) lines.push("units that answered a sweep:");
  for (const found of decoded.discovered) {
    lines.push(
      `  request ${hexNumber(found.requestId, 3)} -> response ${hexNumber(found.responseId, 3)}: ${found.detail}`,
    );
  }
  lines.push(
    `undecoded: ${String(decoded.undecoded.length)} of ${String(decoded.exchanges)} exchanges`,
  );
  for (const exchange of decoded.undecoded) lines.push(`  ${undecodedLine(exchange)}`);
  return lines;
}
