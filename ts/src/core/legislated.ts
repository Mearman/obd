/**
 * The legislated reads beyond the codes: supported values, readiness, monitor results, calibration.
 *
 * Every request is read-only and goes through the guard (`readAnswers` permits each one). A car says
 * in its supported-identifier bitmaps which values it holds, so nothing is requested that it has
 * said it lacks.
 */

import { byteAt, hexNumber } from "./bytes.js";
import type { Elm } from "./elm.js";
import { formatSignificant, roundToThousandths } from "./format.js";
import {
  CURRENT_DATA,
  MISFIRE_GENERAL,
  MISFIRE_LAST_CYLINDER,
  MONITOR_ENTRY_LENGTH,
  MONITORING_RESULTS,
  PID_MONITOR_STATUS,
  VEHICLE_INFORMATION,
  readAnswers,
} from "./obd.js";
import { PIDS, type Pid, type Value } from "./pids.js";
import type { LineSink } from "./unit-access.js";

// Identifier 0x00 and every multiple of 0x20 after it answer with a bitmap of the next 32
// identifiers (this is the same in modes 01, 06 and 09). The last bit of a bitmap says whether the
// next bitmap exists.
const BITMAP_SPAN = 0x20;
const BITMAP_BYTES = 4;

const INFO_CALIBRATION_ID = 0x04;
const CALIBRATION_ID_LENGTH = 16;

// Mode 06 monitor identifiers 01 to 10 are the oxygen sensor monitors, in bank then sensor order.
// That follows the mode 05 oxygen sensor table in SAE J1979 as reproduced at
// https://en.wikipedia.org/wiki/OBD-II_PIDs (latest snapshot:
// https://web.archive.org/web/https://en.wikipedia.org/wiki/OBD-II_PIDs), which describes mode 05
// for adapters that are not on CAN; carrying its numbering over to mode 06 is unconfirmed, and no
// source for the other monitor identifiers was opened, so they are shown by number only.
const FIRST_OXYGEN_MONITOR = 0x01;
const LAST_OXYGEN_MONITOR = 0x10;

// Unit and scaling identifiers from 0x80 up describe signed values.
const SIGNED_SCALING = 0x80;

// Readiness monitors common to every engine: (name, availability bit, incomplete bit) in byte B.
const COMMON_MONITORS: readonly (readonly [string, number, number])[] = [
  ["misfire", 0, 4],
  ["fuel system", 1, 5],
  ["components", 2, 6],
];
// Monitors that depend on the engine type: (name, bit) in bytes C and D. Bit 3 of byte B selects the
// table (0 spark ignition, 1 compression ignition). A set bit in C means the monitor is fitted, a
// set bit in D (and in B for the common monitors) means it has not completed.
// Source: the same SAE J1979 table at https://en.wikipedia.org/wiki/OBD-II_PIDs.
const SPARK_MONITORS: readonly (readonly [string, number])[] = [
  ["catalyst", 0],
  ["heated catalyst", 1],
  ["evaporative system", 2],
  ["secondary air", 3],
  ["gasoline particulate filter", 4],
  ["oxygen sensor", 5],
  ["oxygen sensor heater", 6],
  ["EGR or variable valve timing", 7],
];
const COMPRESSION_MONITORS: readonly (readonly [string, number])[] = [
  ["NMHC catalyst", 0],
  ["NOx or SCR", 1],
  ["boost pressure", 3],
  ["exhaust gas sensor", 5],
  ["particulate filter", 6],
  ["EGR or variable valve timing", 7],
];
const COMPRESSION_IGNITION_BIT = 3;

/** Which on-board monitors a unit has, and whether each has completed since codes were cleared. */
export interface MonitorReadiness {
  readonly compressionIgnition: boolean;
  readonly complete: readonly string[];
  readonly incomplete: readonly string[];
}

/** The identifiers `base + 1` to `base + 0x20` that a four-byte bitmap marks as supported. */
export function decodeSupportBitmap(base: number, data: Uint8Array): ReadonlySet<number> {
  const supported = new Set<number>();
  for (let index = 0; index < BITMAP_SPAN; index++) {
    const byte = byteAt(data, Math.floor(index / 8));
    if (((byte >> (7 - (index % 8))) & 1) !== 0) supported.add(base + 1 + index);
  }
  return supported;
}

/**
 * Reads each unit's supported-identifier bitmaps for one mode, following the chain.
 *
 * Reads the bitmap at 0x00, then at each multiple of 0x20 a unit says exists. The result maps a
 * unit's identifier to every identifier it supports, bitmap identifiers included. A unit that does
 * not answer is left out.
 */
export async function supportedIds(elm: Elm, mode: number): Promise<Map<number, Set<number>>> {
  const result = new Map<number, Set<number>>();
  let base = 0x00;
  while (base <= 0xe0) {
    const answers = await readAnswers(elm, Uint8Array.of(mode, base));
    const found = new Map<number, ReadonlySet<number>>();
    for (const [sender, message] of answers) {
      if (message.length >= 2 + BITMAP_BYTES) {
        found.set(sender, decodeSupportBitmap(base, message.slice(2)));
      }
    }
    for (const [sender, ids] of found) {
      const known = result.get(sender) ?? new Set<number>();
      for (const id of ids) known.add(id);
      result.set(sender, known);
    }
    if (!Array.from(found.values()).some((ids) => ids.has(base + BITMAP_SPAN))) break;
    base += BITMAP_SPAN;
  }
  return result;
}

/**
 * Turns the four data bytes of mode 01 identifier 01 into the monitors that completed.
 *
 * A monitor that is not fitted is left out of both lists.
 */
export function decodeReadiness(data: Uint8Array): MonitorReadiness {
  const b = byteAt(data, 1);
  const c = byteAt(data, 2);
  const d = byteAt(data, 3);
  const compression = ((b >> COMPRESSION_IGNITION_BIT) & 1) !== 0;
  const complete: string[] = [];
  const incomplete: string[] = [];

  const place = (name: string, fitted: boolean, notComplete: boolean): void => {
    if (fitted) (notComplete ? incomplete : complete).push(name);
  };

  for (const [name, available, pending] of COMMON_MONITORS) {
    place(name, ((b >> available) & 1) !== 0, ((b >> pending) & 1) !== 0);
  }
  for (const [name, bit] of compression ? COMPRESSION_MONITORS : SPARK_MONITORS) {
    place(name, ((c >> bit) & 1) !== 0, ((d >> bit) & 1) !== 0);
  }
  return { compressionIgnition: compression, complete, incomplete };
}

/** Reads which monitors each unit has completed since its codes were last cleared. */
export async function readinessMonitors(elm: Elm): Promise<Map<number, MonitorReadiness>> {
  const answers = await readAnswers(elm, Uint8Array.of(CURRENT_DATA, PID_MONITOR_STATUS));
  const result = new Map<number, MonitorReadiness>();
  for (const [sender, message] of answers) {
    if (message.length >= 2 + BITMAP_BYTES) result.set(sender, decodeReadiness(message.slice(2)));
  }
  return result;
}

/** Reads one current-data parameter from every unit that answers, decoded. */
export async function readPid(elm: Elm, pid: Pid): Promise<Map<number, readonly Value[]>> {
  const answers = await readAnswers(elm, Uint8Array.of(CURRENT_DATA, pid.code));
  const result = new Map<number, readonly Value[]>();
  for (const [sender, message] of answers) {
    if (message.length >= 2 + pid.size) result.set(sender, pid.decode(message.slice(2)));
  }
  return result;
}

/** One reading as text: numbers rounded to three decimals, with the unit. */
export function formatValue(value: Value, unit: string): string {
  const text = typeof value === "string" ? value : formatSignificant(roundToThousandths(value), 12);
  return `${text} ${unit}`.trimEnd();
}

/** One mode 06 test result: the value and the limits the unit holds it against. */
export class MonitorTest {
  constructor(
    readonly monitor: number,
    readonly test: number,
    readonly scaling: number,
    readonly value: number,
    readonly minimum: number,
    readonly maximum: number,
  ) {}

  /** Whether the value lies between the minimum and maximum, inclusive. */
  get withinLimits(): boolean {
    return this.minimum <= this.value && this.value <= this.maximum;
  }
}

function monitorWord(scaling: number, raw: Uint8Array): number {
  const value = byteAt(raw, 0) * 256 + byteAt(raw, 1);
  return scaling >= SIGNED_SCALING && value >= 0x8000 ? value - 0x10000 : value;
}

/**
 * Splits one mode 06 reply into its tests.
 *
 * Each test is nine bytes: monitor, test, unit and scaling, then value, minimum and maximum as two
 * bytes each. Entries of other monitors are ignored.
 */
export function decodeMonitorTests(monitor: number, message: Uint8Array): MonitorTest[] {
  const body = message.slice(1);
  const tests: MonitorTest[] = [];
  for (let start = 0; start + MONITOR_ENTRY_LENGTH <= body.length; start += MONITOR_ENTRY_LENGTH) {
    const entry = body.slice(start, start + MONITOR_ENTRY_LENGTH);
    if (byteAt(entry, 0) !== monitor) continue;
    const scaling = byteAt(entry, 2);
    tests.push(
      new MonitorTest(
        monitor,
        byteAt(entry, 1),
        scaling,
        monitorWord(scaling, entry.slice(3, 5)),
        monitorWord(scaling, entry.slice(5, 7)),
        monitorWord(scaling, entry.slice(7, 9)),
      ),
    );
  }
  return tests;
}

/** Names a mode 06 monitor where a source for the name is known, else gives its number. */
export function describeMonitor(monitor: number): string {
  if (monitor >= FIRST_OXYGEN_MONITOR && monitor <= LAST_OXYGEN_MONITOR) {
    const index = monitor - FIRST_OXYGEN_MONITOR;
    return `oxygen sensor bank ${String(Math.floor(index / 4) + 1)} sensor ${String((index % 4) + 1)}`;
  }
  return `monitor ${hexNumber(monitor, 2)}`;
}

/**
 * Reads every mode 06 monitor a unit supports except the misfire monitors.
 *
 * The result maps a unit's identifier to its test results. Monitors that are bitmap identifiers,
 * and the misfire monitors (read by `misfireCounts`), are skipped.
 */
export async function monitorResults(elm: Elm): Promise<Map<number, MonitorTest[]>> {
  const supported = await supportedIds(elm, MONITORING_RESULTS);
  const wanted = new Set<number>();
  for (const ids of supported.values()) {
    for (const monitor of ids) {
      if (
        monitor % BITMAP_SPAN !== 0 &&
        !(monitor >= MISFIRE_GENERAL && monitor <= MISFIRE_LAST_CYLINDER)
      ) {
        wanted.add(monitor);
      }
    }
  }
  const result = new Map<number, MonitorTest[]>();
  for (const monitor of Array.from(wanted).sort((a, b) => a - b)) {
    const answers = await readAnswers(elm, Uint8Array.of(MONITORING_RESULTS, monitor));
    for (const [sender, message] of answers) {
      const tests = result.get(sender) ?? [];
      tests.push(...decodeMonitorTests(monitor, message));
      result.set(sender, tests);
    }
  }
  return result;
}

/**
 * Reads each unit's calibration identifiers (mode 09, identifier 04).
 *
 * Asked only when a unit's mode 09 bitmap lists it. A unit reports a count, then that many
 * sixteen-byte texts padded with zero bytes.
 */
export async function calibrationIds(elm: Elm): Promise<Map<number, string[]>> {
  const holders = new Set<number>();
  for (const [sender, ids] of await supportedIds(elm, VEHICLE_INFORMATION)) {
    if (ids.has(INFO_CALIBRATION_ID)) holders.add(sender);
  }
  const result = new Map<number, string[]>();
  if (holders.size === 0) return result;
  const answers = await readAnswers(elm, Uint8Array.of(VEHICLE_INFORMATION, INFO_CALIBRATION_ID));
  for (const [sender, message] of answers) {
    if (!holders.has(sender) || message.length < 3) continue;
    const body = message.slice(3);
    const count = byteAt(message, 2);
    const texts: string[] = [];
    for (
      let start = 0;
      start < body.length && texts.length < count;
      start += CALIBRATION_ID_LENGTH
    ) {
      texts.push(
        Array.from(body.slice(start, start + CALIBRATION_ID_LENGTH))
          .filter((byte) => byte >= 0x20 && byte < 0x7f)
          .map((byte) => String.fromCharCode(byte))
          .join("")
          .trim(),
      );
    }
    result.set(sender, texts);
  }
  return result;
}

/** The decodable current-data parameters that at least one unit supports, in identifier order. */
export function supportedPids(supported: ReadonlyMap<number, ReadonlySet<number>>): Pid[] {
  const wanted = new Set<number>();
  for (const ids of supported.values()) for (const id of ids) wanted.add(id);
  return Array.from(PIDS)
    .sort(([a], [b]) => a - b)
    .filter(([code]) => wanted.has(code))
    .map(([, pid]) => pid);
}

/**
 * Prints what a car says about itself through the legislated reads, asking only for what it
 * supports.
 */
export async function report(elm: Elm, out: LineSink): Promise<void> {
  const current = await supportedIds(elm, CURRENT_DATA);
  if (current.size === 0) out("no unit answered the supported current-data request");
  const multiple = current.size > 1;
  for (const [sender, readiness] of await readinessMonitors(elm)) {
    const engine = readiness.compressionIgnition ? "compression ignition" : "spark ignition";
    out(`readiness from ${hexNumber(sender, 1)} (${engine}):`);
    out(`  complete: ${readiness.complete.join(", ") || "none"}`);
    out(`  not complete: ${readiness.incomplete.join(", ") || "none"}`);
  }
  for (const pid of supportedPids(current)) {
    for (const [sender, values] of await readPid(elm, pid)) {
      const where = multiple ? ` from ${hexNumber(sender, 1)}` : "";
      if (values.length !== pid.columns.length) {
        throw new RangeError(`${pid.name} decoded ${String(values.length)} values for its columns`);
      }
      pid.columns.forEach((column, index) => {
        const value = values[index];
        if (value !== undefined) out(`${column.label}${where}: ${formatValue(value, column.unit)}`);
      });
    }
  }
  const results = await monitorResults(elm);
  if (results.size > 0) {
    out("monitor test results (what each test measures differs per maker: meanings unconfirmed):");
  }
  for (const [sender, tests] of results) {
    for (const test of tests) {
      const verdict = test.withinLimits ? "within" : "outside";
      out(
        `  ${describeMonitor(test.monitor)} from ${hexNumber(sender, 1)}, test ${hexNumber(test.test, 2)} ` +
          `(unit and scaling ${hexNumber(test.scaling, 2)}): value ${String(test.value)}, ` +
          `limits ${String(test.minimum)} to ${String(test.maximum)}, ${verdict} the limits`,
      );
    }
  }
  for (const [sender, identifiers] of await calibrationIds(elm)) {
    out(`calibration identifier from ${hexNumber(sender, 1)}: ${identifiers.join(", ") || "none"}`);
  }
}
