import { parseScan, type SavedScan } from "../../src/core/index.js";

/** Synthetic saved-scan documents for the comparison and describe tests. */
interface UnitOptions {
  answered?: boolean;
  faults?: [string, string][] | null;
  frames?: Record<string, string>;
  ident?: Record<string, string>;
}

export function unit(name: string, options: UnitOptions = {}): Record<string, unknown> {
  const { answered = true, faults = null, frames = {}, ident = {} } = options;
  return {
    unit: name,
    answered,
    faults: faults === null ? null : faults.map(([code, status]) => ({ code, status })),
    freeze_frames: frames,
    identification: Object.fromEntries(
      Object.entries(ident).map(([label, hex]) => [label, { hex, text: "" }]),
    ),
  };
}

export function scan(
  path: string,
  units: Record<string, unknown>[],
  taken = "2026-01-01T00:00:00+00:00",
): SavedScan {
  return parseScan(scanText(units, taken), path);
}

export function scanText(
  units: Record<string, unknown>[],
  taken = "2026-01-01T00:00:00+00:00",
): string {
  return JSON.stringify({
    tool: "obd-read",
    taken,
    profile: { name: "test", status: "confirmed" },
    units,
  });
}
