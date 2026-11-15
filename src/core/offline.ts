/**
 * The saved-file commands that never touch an adapter: compare, describe and import-names.
 *
 * Each function takes parsed input and returns the lines to print (or the document to save). Reading and writing files, parsing the command line and finding a profile by name or path belong to the caller; this module is platform-free.
 */

import { CAPTURE_FORMAT, validateCapture, type Capture } from "./capture.js";
import type { CodeNames } from "./codenames.js";
import {
  CodeNameError,
  namesDocument,
  normaliseCode,
  type Described,
  type NamesDocument,
  type NamesFile,
} from "./codenames.js";
import { decodeCapture, decodedLines, type DecodeTarget } from "./decode.js";
import { DefinitionError, readDefinitions } from "./definitions.js";
import { formatValue } from "./legislated.js";
import type { ObdScan } from "./obd-scan.js";
import {
  ScanFileError,
  compareScans,
  parseScan,
  renderComparison,
  type SavedScan,
} from "./scancompare.js";
import {
  OBD_REPORT_FORMAT,
  captureShareData,
  decodeShare,
  describeSharedCapture,
  describeSharedRun,
  describeSharedScan,
  encodeShare,
  fragmentOfLink,
  obdReportDocumentShareData,
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

/** The envelope that shares a saved document, chosen by its `format`. */
function documentEnvelope(document: unknown, path: string, createdAt: number): ShareEnvelope {
  const format: unknown =
    typeof document === "object" && document !== null ? Reflect.get(document, "format") : undefined;
  if (format === "obd-read-run") {
    return {
      v: 1,
      kind: "run-summary",
      createdAt,
      data: unwrap(runExportShareData(document), path),
    };
  }
  if (format === OBD_REPORT_FORMAT) {
    return {
      v: 1,
      kind: "obd-report",
      createdAt,
      data: unwrap(obdReportDocumentShareData(document), path),
    };
  }
  if (format === CAPTURE_FORMAT) {
    let capture: Capture;
    try {
      capture = validateCapture(document, path);
    } catch (error) {
      if (error instanceof Error) throw new ShareLinkError(error.message);
      throw error;
    }
    return { v: 1, kind: "capture", createdAt, data: unwrap(captureShareData(capture), path) };
  }
  return { v: 1, kind: "scan", createdAt, data: unwrap(scanShareData(document), path) };
}

/** What {@link shareDocumentLink} needs besides the document. */
export interface ShareLinkParams {
  /** The app's address, with its base path; any fragment on it is replaced. */
  readonly base: string;
  readonly codec: ShareCodec;
  /** Blank the VIN and serial numbers of a scan, the VIN and calibration identifiers of a generic OBD-II read, or all three in a capture's raw bytes. */
  readonly redactVin: boolean;
  /** The creation time to record, in milliseconds since the Unix epoch. */
  readonly createdAt: number;
}

/**
 * The link that shares a saved document: a scan report (`scan --output`), a generic OBD-II read (`obd --output`), a run's JSON export or a capture document (`capture --output`, `import-capture --output`, uncompressed); `path` labels it in errors.
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
  const envelope = documentEnvelope(document, path, params.createdAt);
  const encoded = unwrap(
    await encodeShare(envelope, params.codec, { redactVin: params.redactVin }),
    path,
  );
  return shareLink(params.base, encoded.fragment);
}

function codeLines(kind: string, codes: readonly string[], names: CodeNames): string[] {
  return codes.map((code) => `  ${describedLine(`${kind} ${code}`, names.genericCode(code))}`);
}

/**
 * The report lines for a generic OBD-II read: the VIN, then per unit its lamp, each code with its generic title where one is known, readiness, freeze frame, misfire counts and calibration identifiers, then the current-data values and the mode 06 results. A VIN that redaction blanked reads as removed.
 *
 * Throws {@link CodeNameError} when a code is not a valid code.
 */
export function describeObdScan(scan: ObdScan, names: CodeNames): string[] {
  const vin = scan.vin === null ? "not reported" : scan.vin === "" ? "(removed)" : scan.vin;
  const lines = [`VIN: ${vin}`];
  for (const unit of scan.units) {
    const lamp = unit.lampOn === null ? "not reported" : unit.lampOn ? "on" : "off";
    const count = unit.codeCount === null ? "" : `, ${String(unit.codeCount)} stored codes`;
    lines.push(`unit ${unit.sender}: warning lamp ${lamp}${count}`);
    for (const kind of ["stored", "pending", "permanent"] as const) {
      const found = unit[kind];
      if (found === null) lines.push(`  ${kind} codes: not read`);
      else if (found.length === 0) lines.push(`  ${kind} codes: none`);
      else lines.push(...codeLines(kind, found, names));
    }
    if (unit.readiness !== null) {
      const engine = unit.readiness.compressionIgnition ? "compression ignition" : "spark ignition";
      lines.push(
        `  readiness (${engine}): complete ${unit.readiness.complete.join(", ") || "none"}; not complete ${unit.readiness.incomplete.join(", ") || "none"}`,
      );
    }
    if (unit.freezeFrame !== null) {
      lines.push(`  freeze frame: ${unit.freezeFrame.code ?? "no code"}`);
      for (const [name, value] of Object.entries(unit.freezeFrame.values)) {
        lines.push(`    ${name}: ${value}`);
      }
    }
    for (const counts of unit.misfire) {
      lines.push(
        `  misfire ${counts.monitor}: last cycle ${String(counts.lastCycle ?? "not reported")}, average of last ten cycles ${String(counts.averageLastTenCycles ?? "not reported")}`,
      );
    }
    const identifiers = unit.calibrationIds.map((text) => (text === "" ? "(removed)" : text));
    if (identifiers.length > 0) lines.push(`  calibration identifiers: ${identifiers.join(", ")}`);
  }
  for (const reading of scan.values) {
    lines.push(
      `${reading.signal} from ${reading.sender}: ${formatValue(reading.value, reading.unit)}`,
    );
  }
  for (const test of scan.monitorResults) {
    lines.push(
      `${test.monitor} from ${test.sender}, test ${test.test} (unit and scaling ${test.scaling}): ` +
        `value ${String(test.value)}, limits ${String(test.minimum)} to ${String(test.maximum)}, ` +
        `${test.withinLimits ? "within" : "outside"} the limits`,
    );
  }
  for (const note of scan.notes) lines.push(`note: ${note}`);
  return lines;
}

/**
 * The report lines for a share link (or just its fragment): in the format `describe` prints for a saved scan, preceded by where the data came from.
 *
 * `namesFor` gives the code names for the profile the link names, or undefined when it names none the caller knows; it must not read anything the link controls. A capture is decoded with what `decodeWith` chooses for it, and printed as `decode` prints it. Throws {@link ShareLinkError} when the link is not a valid share.
 */
export async function openShareLink(
  link: string,
  codec: ShareCodec,
  namesFor: (profile: string) => CodeNames | undefined,
  generic: CodeNames,
  decodeWith: (capture: Capture) => Promise<DecodeTarget>,
): Promise<string[]> {
  const fragment = fragmentOfLink(link);
  if (fragment === undefined)
    throw new ShareLinkError("not a share link: it has no #share= fragment");
  const envelope = unwrap(await decodeShare(fragment, codec), "share link");
  if (envelope.kind === "run-summary") return describeSharedRun(envelope.data, envelope.createdAt);
  if (envelope.kind === "capture") {
    const { capture } = envelope.data;
    return [
      `shared data, not read from an adapter; link made ${new Date(envelope.createdAt).toISOString()}`,
      ...describeSharedCapture(envelope.data),
      ...decodedLines(await decodeCapture(capture, await decodeWith(capture))),
    ];
  }
  if (envelope.kind === "obd-report") {
    const { data } = envelope;
    return [
      `shared data, not read from an adapter; link made ${new Date(envelope.createdAt).toISOString()}`,
      `shared OBD-II read (taken ${data.taken}, adapter ${data.adapter.label === "" ? "unknown" : data.adapter.label})`,
      data.redacted
        ? "VIN and calibration identifiers were removed before sharing"
        : "VIN and calibration identifiers are included",
      ...describeObdScan(data.obd, generic),
    ];
  }
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
