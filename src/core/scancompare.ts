/**
 * Compare two saved scans: which units answered, which fault codes appeared, cleared or changed.
 *
 * This module is platform-free: it takes a scan's JSON text and a label for it, never a file.
 */

import { z } from "zod";

/** A text is not a scan written by `obd-read scan --output` or `obd-read clear --save`. */
export class ScanFileError extends Error {
  override name = "ScanFileError";
}

/** One unit's entry in a saved scan, reduced to what a comparison needs. */
export interface SavedUnit {
  readonly name: string;
  readonly answered: boolean;
  /** Each reported code with its sorted statuses, or null when the scan did not read fault codes for the unit. */
  readonly faults: ReadonlyMap<string, readonly string[]> | null;
  /** The freeze frame hex by code. */
  readonly freezeFrames: ReadonlyMap<string, string>;
  /** The identification hex by label. */
  readonly identification: ReadonlyMap<string, string>;
}

/** A saved scan: when it was taken, with which profile, and each unit's entry. */
export interface SavedScan {
  /** The label of the file it was read from, used in reports. */
  readonly path: string;
  readonly taken: string;
  readonly profile: string;
  readonly units: ReadonlyMap<string, SavedUnit>;
}

/** Everything that differs for one unit between two scans. */
export class UnitChange {
  presence: string | undefined;
  answering: string | undefined;
  faultsNote: string | undefined;
  readonly appeared: string[] = [];
  readonly cleared: string[] = [];
  readonly changed: string[] = [];
  readonly freezeChanged: string[] = [];
  readonly identificationChanged: string[] = [];

  constructor(readonly unit: string) {}

  /** Whether anything differs. */
  get any(): boolean {
    return (
      Boolean(this.presence) ||
      Boolean(this.answering) ||
      Boolean(this.faultsNote) ||
      this.appeared.length > 0 ||
      this.cleared.length > 0 ||
      this.changed.length > 0 ||
      this.freezeChanged.length > 0 ||
      this.identificationChanged.length > 0
    );
  }
}

const scanSchema = z.object({
  taken: z.string(),
  profile: z.object({ name: z.string() }),
  units: z.array(
    z.object({
      unit: z.string(),
      answered: z.boolean({ error: "must be true or false" }),
      faults: z.array(z.object({ code: z.string(), status: z.string() })).nullish(),
      freeze_frames: z.record(z.string(), z.string()).default({}),
      identification: z.record(z.string(), z.object({ hex: z.string() })).default({}),
    }),
  ),
});

function describe(where: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return `${where}: not a scan`;
  const path = issue.path.map(String).join(".");
  return `${where}: ${path === "" ? "" : `${path}: `}${issue.message}`;
}

/** Reads a saved scan from its JSON text; `path` labels it. Throws {@link ScanFileError} when it is not one. */
export function parseScan(text: string, path: string): SavedScan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ScanFileError(`${path}: ${error.message}`);
    throw error;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ScanFileError(`${path}: expected an object`);
  }
  if (Reflect.get(data, "tool") !== "obd-read") {
    throw new ScanFileError(`${path}: not an obd-read scan (no tool field)`);
  }
  const parsed = scanSchema.safeParse(data);
  if (!parsed.success) throw new ScanFileError(describe(path, parsed.error));
  const units = new Map<string, SavedUnit>();
  for (const entry of parsed.data.units) {
    if (units.has(entry.unit)) throw new ScanFileError(`${path}: unit ${entry.unit} appears twice`);
    let faults: Map<string, string[]> | null = null;
    if (entry.faults != null) {
      faults = new Map();
      for (const fault of entry.faults) {
        const statuses = faults.get(fault.code);
        if (statuses === undefined) faults.set(fault.code, [fault.status]);
        else statuses.push(fault.status);
      }
      for (const statuses of faults.values()) statuses.sort();
    }
    units.set(entry.unit, {
      name: entry.unit,
      answered: entry.answered,
      faults,
      freezeFrames: new Map(Object.entries(entry.freeze_frames)),
      identification: new Map(
        Object.entries(entry.identification).map(([label, value]) => [label, value.hex]),
      ),
    });
  }
  return { path, taken: parsed.data.taken, profile: parsed.data.profile.name, units };
}

function joined(statuses: readonly string[]): string {
  return statuses.join("/");
}

function sameStatuses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((status, index) => status === b[index]);
}

/** The text of an identification, or `absent` when there is none or it is empty. */
function absent(hex: string | undefined): string {
  return hex === undefined || hex === "" ? "absent" : hex;
}

function compareUnit(name: string, before: SavedUnit, after: SavedUnit): UnitChange {
  const change = new UnitChange(name);
  if (before.answered !== after.answered) {
    change.answering = after.answered ? "started answering" : "stopped answering";
  }
  if (before.faults === null || after.faults === null) {
    if ((before.faults === null) !== (after.faults === null)) {
      change.faultsNote = `fault codes were not read in the ${before.faults === null ? "first" : "second"} scan`;
    } else if (before.answered || after.answered) {
      change.faultsNote = "fault codes were not read in either scan";
    }
  } else {
    for (const [code, statuses] of after.faults) {
      const earlier = before.faults.get(code);
      if (earlier === undefined) change.appeared.push(`${code} (status ${joined(statuses)})`);
      else if (!sameStatuses(earlier, statuses)) {
        change.changed.push(`${code}: status ${joined(earlier)} -> ${joined(statuses)}`);
      }
    }
    for (const [code, statuses] of before.faults) {
      if (!after.faults.has(code)) change.cleared.push(`${code} (status ${joined(statuses)})`);
    }
    for (const [code, frame] of after.freezeFrames) {
      const earlier = before.freezeFrames.get(code);
      if (earlier !== undefined && earlier !== frame && before.faults.has(code)) {
        change.freezeChanged.push(`${code}: ${earlier} -> ${frame}`);
      }
    }
  }
  const labels = [
    ...new Set([...before.identification.keys(), ...after.identification.keys()]),
  ].sort();
  for (const label of labels) {
    const old = before.identification.get(label);
    const now = after.identification.get(label);
    if (old !== now)
      change.identificationChanged.push(`${label}: ${absent(old)} -> ${absent(now)}`);
  }
  return change;
}

/**
 * Per unit, what differs between two scans. Units with no difference are omitted.
 *
 * Units are ordered as in the first scan, then those only in the second. Fault codes are compared only when both scans read them for the unit, and a code's freeze frame only when both scans hold one for it.
 */
export function compareScans(before: SavedScan, after: SavedScan): UnitChange[] {
  const names = [
    ...before.units.keys(),
    ...[...after.units.keys()].filter((name) => !before.units.has(name)),
  ];
  const changes: UnitChange[] = [];
  for (const name of names) {
    const old = before.units.get(name);
    const now = after.units.get(name);
    if (old === undefined || now === undefined) {
      const change = new UnitChange(name);
      change.presence = old === undefined ? "only in the second scan" : "only in the first scan";
      changes.push(change);
      continue;
    }
    const change = compareUnit(name, old, now);
    if (change.any) changes.push(change);
  }
  return changes;
}

/** The comparison as plain text lines. */
export function renderComparison(
  before: SavedScan,
  after: SavedScan,
  changes: readonly UnitChange[],
): string[] {
  const lines = [
    `first scan:  ${before.path} (taken ${before.taken}, profile ${before.profile})`,
    `second scan: ${after.path} (taken ${after.taken}, profile ${after.profile})`,
  ];
  if (before.profile !== after.profile) {
    lines.push("note: the scans used different profiles, so unit names may not line up");
  }
  if (changes.length === 0) {
    lines.push("no differences");
    return lines;
  }
  for (const change of changes) {
    lines.push(`${change.unit}:`);
    if (change.presence) lines.push(`  unit ${change.presence}`);
    if (change.answering) lines.push(`  ${change.answering}`);
    if (change.faultsNote) lines.push(`  ${change.faultsNote}`);
    for (const [label, items] of [
      ["appeared", change.appeared],
      ["cleared", change.cleared],
      ["changed", change.changed],
      ["freeze frame changed", change.freezeChanged],
      ["identification changed", change.identificationChanged],
    ] as const) {
      for (const item of items) lines.push(`  ${label}: ${item}`);
    }
  }
  return lines;
}
