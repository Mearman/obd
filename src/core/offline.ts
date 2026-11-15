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
import {
  ScanFileError,
  compareScans,
  parseScan,
  renderComparison,
  type SavedScan,
} from "./scancompare.js";
import {
  decodeShare,
  describeSharedRun,
  describeSharedScan,
  encodeShare,
  fragmentOfLink,
  runExportShareData,
  scanShareData,
  shareLink,
  sharedScanReport,
  type ShareCodec,
  type ShareEnvelope,
  type ShareResult,
} from "./share.js";

/** The names of the saved-file commands. */
export const OFFLINE_COMMANDS = ["compare", "describe", "import-names", "share"] as const;

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

/** A saved report cannot be shared, or a share link cannot be opened. */
export class ShareLinkError extends Error {
  override name = "ShareLinkError";
}

function unwrap<T>(result: ShareResult<T>, label: string): T {
  if (!result.ok) throw new ShareLinkError(`${label}: ${result.error.message}`);
  return result.value;
}

/** What {@link shareDocumentLink} needs besides the document. */
export interface ShareLinkParams {
  /** The app's address, with its base path; any fragment on it is replaced. */
  readonly base: string;
  readonly codec: ShareCodec;
  /** Blank the VIN and serial numbers of a scan. */
  readonly redactVin: boolean;
  /** The creation time to record, in milliseconds since the Unix epoch. */
  readonly createdAt: number;
}

/**
 * The link that shares a saved document: a scan report (`scan --output`) or a run's JSON export; `path` labels it in errors.
 *
 * Throws {@link ShareLinkError} when the text is neither, or when the link would pass a size limit.
 */
export async function shareDocumentLink(
  text: string,
  path: string,
  params: ShareLinkParams,
): Promise<string> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ShareLinkError(`${path}: ${error.message}`);
    throw error;
  }
  const isRun =
    typeof document === "object" &&
    document !== null &&
    Reflect.get(document, "format") === "obd-read-run";
  const envelope: ShareEnvelope = isRun
    ? {
        v: 1,
        kind: "run-summary",
        createdAt: params.createdAt,
        data: unwrap(runExportShareData(document), path),
      }
    : {
        v: 1,
        kind: "scan",
        createdAt: params.createdAt,
        data: unwrap(scanShareData(document), path),
      };
  const encoded = unwrap(
    await encodeShare(envelope, params.codec, { redactVin: params.redactVin }),
    path,
  );
  return shareLink(params.base, encoded.fragment);
}

/**
 * The report lines for a share link (or just its fragment): in the format `describe` prints for a saved scan, preceded by where the data came from.
 *
 * `namesFor` gives the code names for the profile the link names, or undefined when it names none the caller knows; it must not read anything the link controls. Throws {@link ShareLinkError} when the link is not a valid share.
 */
export async function openShareLink(
  link: string,
  codec: ShareCodec,
  namesFor: (profile: string) => CodeNames | undefined,
  generic: CodeNames,
): Promise<string[]> {
  const fragment = fragmentOfLink(link);
  if (fragment === undefined)
    throw new ShareLinkError("not a share link: it has no #share= fragment");
  const envelope = unwrap(await decodeShare(fragment, codec), "share link");
  if (envelope.kind === "run-summary") return describeSharedRun(envelope.data, envelope.createdAt);
  const saved = parseScan(JSON.stringify(sharedScanReport(envelope.data)), "shared link");
  return [
    `shared data, not read from an adapter; link made ${new Date(envelope.createdAt).toISOString()}`,
    ...describeSharedScan(envelope.data, envelope.createdAt).slice(1, 2),
    ...describeScan(saved, namesFor(envelope.data.profile.name) ?? generic),
  ];
}

/**
 * The line a saved-file command prints when it fails, or undefined when `error` is not one of the failures these commands report (the caller exits with status 1 for the former and rethrows the latter).
 */
export function offlineErrorLine(error: unknown): string | undefined {
  if (
    error instanceof ScanFileError ||
    error instanceof ShareLinkError ||
    error instanceof CodeNameError ||
    error instanceof DefinitionError
  ) {
    return `error: ${error.message}`;
  }
  return undefined;
}
