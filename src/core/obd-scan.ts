/**
 * The legislated OBD-II scan as data: everything the profile-free reads say about a car, grouped by the unit that answered.
 *
 * {@link obdReport} prints the same reads as lines for the command line; this returns them structured for the service and the app. Every request goes through the guard (`readAnswers` permits each one), so a scan sends only read-only OBD-II modes. This module is platform-free.
 */

import { z } from "zod";
import { hexNumber } from "./bytes.js";
import { ElmError, type Elm } from "./elm.js";
import {
  calibrationIds,
  describeMonitor,
  monitorResults,
  readPid,
  readinessMonitors,
  supportedIds,
  supportedPids,
} from "./legislated.js";
import {
  CURRENT_DATA,
  FUNCTIONAL_ID,
  MISFIRE_FIRST_CYLINDER,
  MISFIRE_GENERAL,
  PENDING_CODES,
  PERMANENT_CODES,
  STORED_CODES,
  codes,
  freezeFrame,
  misfireCounts,
  readiness,
  vin,
} from "./obd.js";

const textList = z.array(z.string());

/** What one emissions-related unit said to the legislated reads. */
export const obdUnitScanSchema = z.object({
  /** The unit's response identifier as upper-case hexadecimal. */
  sender: z.string(),
  /** Whether the warning lamp is on, or `null` when the unit did not report it. */
  lampOn: z.boolean().nullable(),
  /** The unit's own count of stored codes, or `null` when it did not report it. */
  codeCount: z.number().int().nonnegative().nullable(),
  /** The stored codes, or `null` when the unit gave none of this kind (not read, or not answered). */
  stored: textList.nullable(),
  pending: textList.nullable(),
  permanent: textList.nullable(),
  readiness: z
    .object({
      compressionIgnition: z.boolean(),
      complete: textList,
      incomplete: textList,
    })
    .nullable(),
  /** The freeze frame: the frozen code (or `null`) and the stored values by label. */
  freezeFrame: z
    .object({ code: z.string().nullable(), values: z.record(z.string(), z.string()) })
    .nullable(),
  misfire: z.array(
    z.object({
      monitor: z.string(),
      lastCycle: z.number().nullable(),
      averageLastTenCycles: z.number().nullable(),
    }),
  ),
  calibrationIds: textList,
});

/** What one unit said. */
export type ObdUnitScan = z.output<typeof obdUnitScanSchema>;

/** The result of the legislated OBD-II reads. */
export const obdScanSchema = z.object({
  /** The vehicle identification number, or `null` when no unit reported one. */
  vin: z.string().nullable(),
  units: z.array(obdUnitScanSchema),
  /** The current-data values the car lists as supported, as read once. */
  values: z.array(
    z.object({
      sender: z.string(),
      signal: z.string(),
      unit: z.string(),
      value: z.union([z.number(), z.string()]),
    }),
  ),
  /** Mode 06 results other than the misfire counters; what each test measures differs per maker. */
  monitorResults: z.array(
    z.object({
      sender: z.string(),
      monitor: z.string(),
      test: z.string(),
      scaling: z.string(),
      value: z.number(),
      minimum: z.number(),
      maximum: z.number(),
      withinLimits: z.boolean(),
    }),
  ),
  /** Reads that failed or reported nothing, in words. */
  notes: textList,
});

/** The result of the legislated OBD-II reads. */
export type ObdScan = z.output<typeof obdScanSchema>;

function emptyUnit(sender: string): ObdUnitScan {
  return {
    sender,
    lampOn: null,
    codeCount: null,
    stored: null,
    pending: null,
    permanent: null,
    readiness: null,
    freezeFrame: null,
    misfire: [],
    calibrationIds: [],
  };
}

/**
 * Selects the bus, addresses every emissions unit and reads everything the legislated services offer.
 *
 * A car is asked only for what its supported-identifier bitmaps list. A kind of fault code a unit refuses to give is recorded in `notes` and left `null` for that kind.
 *
 * @throws ElmError, NegativeResponse and TransportError as the layers below do.
 */
export async function readObdScan(
  elm: Elm,
  bus: { readonly idBits: 11 | 29; readonly bitrate: number },
): Promise<ObdScan> {
  await elm.selectCan(bus.idBits, bus.bitrate);
  await elm.addressFunctional(FUNCTIONAL_ID[bus.idBits]);
  return readAddressedObdScan(elm);
}

/**
 * Reads everything the legislated services offer from a session that is already on the bus and addressed to every emissions unit (`addressFunctional`), CAN or K-line.
 *
 * @throws ElmError, NegativeResponse and TransportError as the layers below do.
 */
export async function readAddressedObdScan(elm: Elm): Promise<ObdScan> {
  const units = new Map<number, ObdUnitScan>();
  const unit = (sender: number): ObdUnitScan => {
    const known = units.get(sender);
    if (known !== undefined) return known;
    const created = emptyUnit(hexNumber(sender, 1));
    units.set(sender, created);
    return created;
  };
  const notes: string[] = [];

  const found = await vin(elm);
  for (const [sender, state] of await readiness(elm)) {
    Object.assign(unit(sender), { lampOn: state.lampOn, codeCount: state.codeCount });
  }
  const kinds = [
    ["stored", STORED_CODES],
    ["pending", PENDING_CODES],
    ["permanent", PERMANENT_CODES],
  ] as const;
  for (const [kind, mode] of kinds) {
    try {
      for (const [sender, list] of await codes(elm, mode)) unit(sender)[kind] = list;
    } catch (error) {
      if (!(error instanceof ElmError)) throw error;
      notes.push(`${kind} codes not read: ${error.message}`);
    }
  }

  const current = await supportedIds(elm, CURRENT_DATA);
  if (current.size === 0) notes.push("no unit answered the supported current-data request");
  for (const [sender, monitors] of await readinessMonitors(elm)) {
    unit(sender).readiness = {
      compressionIgnition: monitors.compressionIgnition,
      complete: [...monitors.complete],
      incomplete: [...monitors.incomplete],
    };
  }
  const values: ObdScan["values"] = [];
  for (const pid of supportedPids(current)) {
    for (const [sender, readings] of await readPid(elm, pid)) {
      pid.columns.forEach((column, index) => {
        const value = readings[index];
        if (value === undefined) return;
        values.push({
          sender: hexNumber(sender, 1),
          signal: column.label,
          unit: column.unit,
          value,
        });
      });
    }
  }

  const results: ObdScan["monitorResults"] = [];
  for (const [sender, tests] of await monitorResults(elm)) {
    for (const test of tests) {
      results.push({
        sender: hexNumber(sender, 1),
        monitor: describeMonitor(test.monitor),
        test: hexNumber(test.test, 2),
        scaling: hexNumber(test.scaling, 2),
        value: test.value,
        minimum: test.minimum,
        maximum: test.maximum,
        withinLimits: test.withinLimits,
      });
    }
  }
  for (const [sender, identifiers] of await calibrationIds(elm)) {
    unit(sender).calibrationIds = identifiers;
  }
  for (const [sender, frame] of await freezeFrame(elm)) {
    unit(sender).freezeFrame = { code: frame.code, values: Object.fromEntries(frame.values) };
  }
  for (const [sender, monitors] of await misfireCounts(elm)) {
    unit(sender).misfire = monitors.map((counts) => ({
      monitor:
        counts.monitor === MISFIRE_GENERAL
          ? "engine"
          : `cylinder ${String(counts.monitor - MISFIRE_FIRST_CYLINDER + 1)}`,
      lastCycle: counts.lastCycle ?? null,
      averageLastTenCycles: counts.averageLastTenCycles ?? null,
    }));
  }

  return {
    vin: found ?? null,
    units: [...units.values()],
    values,
    monitorResults: results,
    notes,
  };
}
