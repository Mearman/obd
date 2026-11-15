/**
 * The saved-file commands that never touch an adapter: compare, describe and import-names.
 *
 * Each function takes parsed input and returns the lines to print (or the document to save). Reading and writing files, parsing the command line and finding a profile by name or path belong to the caller; this module is platform-free.
 */

import type { CodeNames } from "./codenames.js";
import {
  CodeNameError,
  namesDocument,
  normaliseCode,
  type Described,
  type NamesDocument,
  type NamesFile,
} from "./codenames.js";
import { DefinitionError, readDefinitions } from "./definitions.js";
import { ScanFileError, compareScans, renderComparison, type SavedScan } from "./scancompare.js";

/** The names of the saved-file commands. */
export const OFFLINE_COMMANDS = ["compare", "describe", "import-names"] as const;

/** The report lines comparing two saved scans, per unit what appeared, cleared or changed. */
export function compareReport(first: SavedScan, second: SavedScan): string[] {
  return renderComparison(first, second, compareScans(first, second));
}

/** One report line: `<label>: <text>  [<source>]`, or `<label>: no description known`. */
export function describedLine(label: string, described: Described | undefined): string {
  if (described === undefined) return `${label}: no description known`;
  return `${label}: ${described.text}  [${described.source}]`;
}

/**
 * The report lines naming every fault code a saved scan holds: a header, then one line per code with its statuses, from `names`' per-unit tables.
 *
 * A unit whose fault codes the scan did not read has no lines.
 */
export function describeScan(scan: SavedScan, names: CodeNames): string[] {
  const lines = [`${scan.path} (taken ${scan.taken}, profile ${scan.profile})`];
  for (const unit of scan.units.values()) {
    if (unit.faults === null) continue;
    for (const [code, statuses] of unit.faults) {
      lines.push(
        `  ${describedLine(`${unit.name} ${code} status ${statuses.join("/")}`, names.unitCode(unit.name, code))}`,
      );
    }
  }
  return lines;
}

/**
 * The report line for one fault code given directly: an SAE code from the generic list when there is no `unit`, otherwise the unit's table (profile, then imported names).
 *
 * Throws {@link CodeNameError} when `item` is not a valid code.
 */
export function describeCode(item: string, unit: string | undefined, names: CodeNames): string {
  const key = normaliseCode(item);
  if (unit === undefined) return describedLine(key, names.genericCode(key));
  return describedLine(`${unit} ${key}`, names.unitCode(unit, key));
}

/**
 * The report lines naming requests (hexadecimal bytes, spaces and case ignored) of `unit` from imported names files, the first file holding a name winning.
 *
 * Throws {@link CodeNameError} when there is no `unit`.
 */
export function describeRequests(
  requests: readonly string[],
  unit: string | undefined,
  imported: readonly NamesFile[],
): string[] {
  if (unit === undefined) throw new CodeNameError("requests need a unit");
  return requests.map((request) => {
    const key = request.replaceAll(" ", "").toUpperCase();
    const label = imported
      .map((file) => file.values.get(unit)?.get(key))
      .find((found) => found !== undefined);
    return `${unit} ${key}: ${label ?? "no name known"}`;
  });
}

/** What an import produced: the document to save and the lines to print. */
export interface ImportResult {
  readonly document: NamesDocument;
  readonly lines: string[];
}

/**
 * Reads fault-code texts and request names from a definition file for one unit.
 *
 * `data` is the file's bytes and `fileName` its name (its suffix chooses the reader, and it is recorded as the source). The lines give the counts, then a note for each conflict and skipped entry. Throws {@link DefinitionError} as {@link readDefinitions} does.
 */
export function importNames(
  data: Uint8Array,
  fileName: string,
  unit: string,
  variant?: string,
): ImportResult {
  const definitions = readDefinitions(data, fileName, variant);
  return {
    document: namesDocument(fileName, unit, definitions.codes, definitions.values),
    lines: [
      `read ${String(definitions.codes.size)} fault codes and ${String(definitions.values.size)} requests`,
      ...[...definitions.conflicts, ...definitions.skipped].map((line) => `note: ${line}`),
    ],
  };
}

/** The closing line of an import, after the document has been written to `output`. */
export function wroteLine(output: string, fileName: string): string {
  return `wrote ${output}; it holds names from ${fileName} and must not be published`;
}

/**
 * The line a saved-file command prints when it fails, or undefined when `error` is not one of the failures these commands report (the caller exits with status 1 for the former and rethrows the latter).
 */
export function offlineErrorLine(error: unknown): string | undefined {
  if (
    error instanceof ScanFileError ||
    error instanceof CodeNameError ||
    error instanceof DefinitionError
  ) {
    return `error: ${error.message}`;
  }
  return undefined;
}
