/**
 * Live values by name, once or repeatedly, printed and optionally logged to CSV.
 *
 * Two kinds of value share one reading loop: the legislated current-data values (any compliant car,
 * named by `pids`, offered only where the car's supported-identifier bitmaps list them) and the
 * named values a vehicle profile defines for one unit (KWP2000 local identifiers and UDS data
 * identifiers).
 */

import { NegativeResponse } from "./diag.js";
import { ElmError, type Elm } from "./elm.js";
import { formatSignificant } from "./format.js";
import { formatValue, readPid, supportedIds, supportedPids } from "./legislated.js";
import { CURRENT_DATA, FUNCTIONAL_ID } from "./obd.js";
import { OptionError } from "./options.js";
import type { Column, Value } from "./pids.js";
import {
  ProfileError,
  canBus,
  decodeValue,
  profileUnit,
  type DataValue,
  type Profile,
  type Unit,
} from "./profile.js";
import type { OpenCsvLog } from "./openlog.js";
import { isoNow, now, sleep } from "./time.js";
import { makeClient, type LineSink } from "./unit-access.js";

/** One reading, or `undefined` where the value could not be read this time. */
export type Reading = Value | undefined;

/** What a live run reads: one column per reading, and a way to read them all once. */
export interface Source {
  /** One column per reading. */
  readonly columns: readonly Column[];
  /**
   * Reads every column once. Takes a printer for anything worth saying about a read and returns
   * one entry per column.
   */
  readonly read: (out: LineSink) => Promise<readonly Reading[]>;
  /** The names that can be chosen. */
  readonly available: readonly string[];
  /** Lines shown before the first sample. */
  readonly notes: readonly string[];
}

/** The CSV header and printed name for one column. */
export function columnTitle(column: Column): string {
  return column.unit === "" ? column.label : `${column.label} (${column.unit})`;
}

/**
 * The requested names, or all of `available` when none were requested.
 *
 * @throws OptionError listing the available names when a requested one is not among them.
 */
export function choose(
  available: readonly string[],
  wanted: readonly string[],
  what: string,
): readonly string[] {
  const unknown = wanted.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new OptionError(
      `unknown ${what} ${unknown.join(", ")}; available: ${available.join(", ")}`,
    );
  }
  return wanted.length > 0 ? wanted : available;
}

/**
 * The legislated values the car supports, or those named in `wanted`.
 *
 * @throws OptionError when a name is unknown or the car does not list it as supported.
 */
export async function legislatedSource(elm: Elm, wanted: readonly string[]): Promise<Source> {
  const pids = new Map(
    supportedPids(await supportedIds(elm, CURRENT_DATA)).map((pid) => [pid.name, pid]),
  );
  if (pids.size === 0) throw new OptionError("no unit reported any supported current-data value");
  const available = Array.from(pids.keys());
  const chosen = choose(available, wanted, "value").flatMap((name) => {
    const pid = pids.get(name);
    return pid === undefined ? [] : [pid];
  });
  return {
    columns: chosen.flatMap((pid) => pid.columns),
    read: async () => {
      const readings: Reading[] = [];
      for (const pid of chosen) {
        const answers = await readPid(elm, pid);
        // With several answering units the first one to reply is logged.
        const first = answers.values().next();
        readings.push(...(first.done === true ? pid.columns.map(() => undefined) : first.value));
      }
      return readings;
    },
    available,
    notes: [],
  };
}

/**
 * The named values the profile defines for one unit, or those named in `wanted`.
 *
 * Opens the profile's diagnostic session first.
 *
 * @throws OptionError when the unit defines no values or a name is unknown.
 * @throws NegativeResponse when the unit refuses the session.
 * @throws ElmError when the session cannot be opened.
 */
export async function unitSource(
  elm: Elm,
  profile: Profile,
  unit: Unit,
  wanted: readonly string[],
): Promise<Source> {
  if (unit.values.size === 0) {
    throw new OptionError(`unit ${unit.name} in profile ${profile.name} defines no named values`);
  }
  const available = Array.from(unit.values.keys());
  const chosen = choose(available, wanted, "value").flatMap((name) => {
    const item = unit.values.get(name);
    return item === undefined ? [] : [item];
  });
  await elm.addressUnit(unit.requestId, unit.responseId);
  const client = makeClient(elm, profile, unit);
  await client.start();
  const refused = new Set<string>();

  const readOne = async (item: DataValue, out: LineSink): Promise<Reading> => {
    try {
      return decodeValue(item, await client.readValue(item.identifier));
    } catch (error) {
      if (
        error instanceof NegativeResponse ||
        error instanceof ElmError ||
        error instanceof RangeError
      ) {
        // Say so once; a value a unit refuses is refused on every sample.
        if (!refused.has(item.name)) {
          refused.add(item.name);
          out(`${item.name} not read: ${error.message}`);
        }
        return undefined;
      }
      throw error;
    }
  };

  const unconfirmed = chosen.filter((item) => item.status !== "confirmed").map((item) => item.name);
  return {
    columns: chosen.map((item) => ({ label: item.label, unit: item.unit })),
    read: async (out) => {
      const readings: Reading[] = [];
      for (const item of chosen) readings.push(await readOne(item, out));
      return readings;
    },
    available,
    notes:
      unconfirmed.length > 0
        ? [`unconfirmed identifiers, check against the car: ${unconfirmed.join(", ")}`]
        : [],
  };
}

/** How a run is sampled and logged. */
export interface SampleOptions {
  /** How many samples to take. */
  readonly count: number;
  /** The gap between samples, in milliseconds. */
  readonly intervalMs: number;
  /** Opens the CSV log the samples are also written to. */
  readonly openLog?: OpenCsvLog;
}

/** Reads the source `count` times, `intervalMs` apart, printing and logging each sample. */
export async function runSamples(
  source: Source,
  options: SampleOptions,
  out: LineSink,
): Promise<void> {
  const titles = source.columns.map(columnTitle);
  for (const note of source.notes) out(note);
  const log = await options.openLog?.(["time", "elapsed (s)", ...titles]);
  const start = now();
  try {
    for (let index = 0; index < options.count; index++) {
      if (index > 0) await sleep(options.intervalMs);
      const readings = await source.read(out);
      const elapsed = (now() - start) / 1000;
      if (options.count > 1) out(`sample ${String(index + 1)} at ${elapsed.toFixed(1)} s:`);
      if (readings.length !== source.columns.length) {
        throw new RangeError(
          `a source with ${String(source.columns.length)} columns read ${String(readings.length)} values`,
        );
      }
      source.columns.forEach((column, position) => {
        const reading = readings[position];
        const shown = reading === undefined ? "not read" : formatValue(reading, column.unit);
        out(`${column.label}: ${shown}`);
      });
      await log?.write([
        isoNow(),
        elapsed.toFixed(3),
        ...readings.map((reading) =>
          reading === undefined
            ? ""
            : typeof reading === "string"
              ? reading
              : formatSignificant(reading, 10),
        ),
      ]);
    }
  } finally {
    await log?.close();
  }
}

/** The comma-separated value names on the command line. */
export function splitNames(text: string | undefined): string[] {
  return text === undefined
    ? []
    : text
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
}

/** What a live-style command was asked to read. */
export interface SourceOptions {
  /** A unit in the profile; absent to read the legislated OBD-II values. */
  readonly unit?: string;
  /** Value names; none means every value. */
  readonly values: readonly string[];
  /** The identifier width for the legislated values. */
  readonly idBits: 11 | 29;
  /** The CAN bit rate in bit/s for the legislated values. */
  readonly bitrate: number;
}

/**
 * Selects the bus and builds the source a unit's profile values or the legislated values name.
 *
 * @throws OptionError for a bad value name.
 * @throws ProfileError for a unit named without a profile, an unknown unit or a K-line profile.
 */
export async function buildSource(
  elm: Elm,
  profile: Profile | undefined,
  options: SourceOptions,
  out: LineSink,
): Promise<Source> {
  if (options.unit === undefined) {
    await elm.selectCan(options.idBits, options.bitrate);
    await elm.addressFunctional(FUNCTIONAL_ID[options.idBits]);
    return legislatedSource(elm, options.values);
  }
  if (profile === undefined) throw new ProfileError(["naming a unit needs --profile"]);
  const { idBits, bitrate } = canBus(profile);
  await elm.selectCan(idBits, bitrate);
  if (profile.status !== "confirmed") {
    out(`profile ${profile.name}: address table is ${profile.status}`);
  }
  return unitSource(elm, profile, profileUnit(profile, options.unit), options.values);
}

/** What the `live` command was asked to do. */
export interface LiveOptions extends SourceOptions, SampleOptions {
  /** Print the available value names and read nothing. */
  readonly list: boolean;
}

/**
 * Runs the `live` command: a unit's profile values when a unit is named, else the legislated ones.
 *
 * @returns The exit status, always 0.
 * @throws OptionError for a bad count, interval or value name.
 * @throws ProfileError for a unit named without a profile.
 */
export async function liveCommand(
  elm: Elm,
  profile: Profile | undefined,
  options: LiveOptions,
  out: LineSink,
): Promise<number> {
  if (options.count < 1) throw new OptionError("--count must be at least 1");
  if (options.intervalMs < 0) throw new OptionError("--interval must not be negative");
  const source = await buildSource(elm, profile, options, out);
  if (options.list) {
    out(`available values: ${source.available.join(", ")}`);
    return 0;
  }
  await runSamples(source, options, out);
  return 0;
}
