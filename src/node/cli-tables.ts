/**
 * The command line's table output: `--format json|csv|tsv` and `--table <view>` on the commands that print a result, the views defined once in core (`tabular-views.ts`).
 */

import {
  OptionError,
  faultCodeRows,
  identificationRows,
  obdFaultCodeRows,
  obdIdentificationRows,
  renderTable,
  FAULT_CODE_TABLE,
  IDENTIFICATION_TABLE,
  TABLE_FORMATS,
  type CodeDescriber,
  type ObdScan,
  type TableFormat,
  type UnitReport,
} from "../core/index.js";
import type { ParsedArgs } from "./cli-args.js";

/** A table the command prints in place of its text: the format and which view of the result. */
export interface TableRequest {
  readonly format: TableFormat;
  readonly view: string;
}

/** The views of a scan, a unit read and a generic OBD-II read. */
export const UNIT_VIEWS = ["faults", "identification"] as const;

/**
 * The table `--format` asks for, or `undefined` for the command's text. `views` lists the choices of `--table`, the first being the default.
 *
 * @throws OptionError when `--table` is given without `--format`.
 */
export function tableRequest(args: ParsedArgs, views: readonly string[]): TableRequest | undefined {
  const requested = args.optionalText("format");
  const view = args.optionalText("table");
  if (requested === undefined) {
    if (view !== undefined) throw new OptionError("--table needs --format");
    return undefined;
  }
  const format = TABLE_FORMATS.find((candidate) => candidate === requested);
  if (format === undefined) throw new OptionError(`unknown format ${requested}`);
  return { format, view: view ?? views[0] ?? "" };
}

/** The unit reports of a probe, scan or unit read as the requested table's text, without its final line terminator. */
export function unitReportsTable(
  request: TableRequest,
  reports: readonly UnitReport[],
  describe: CodeDescriber,
): string {
  if (request.view === "identification") {
    const rows = identificationRows(
      reports.map((report) => ({
        unit: report.unit,
        identification: Array.from(report.identification, ([label, value]) => ({
          label,
          hex: value.hex,
          text: value.text,
        })),
      })),
    );
    return withoutTerminator(renderTable(request.format, IDENTIFICATION_TABLE, rows));
  }
  return withoutTerminator(
    renderTable(request.format, FAULT_CODE_TABLE, faultCodeRows(reports, describe)),
  );
}

/** A generic OBD-II read (`null` for a capture that holds none, which gives the header alone) as the requested table's text, without its final line terminator. */
export function obdScanTable(
  request: TableRequest,
  scan: ObdScan | null,
  describe: CodeDescriber,
): string {
  return withoutTerminator(
    request.view === "identification"
      ? renderTable(
          request.format,
          IDENTIFICATION_TABLE,
          scan === null ? [] : obdIdentificationRows(scan),
        )
      : renderTable(
          request.format,
          FAULT_CODE_TABLE,
          scan === null ? [] : obdFaultCodeRows(scan, describe),
        ),
  );
}

/** `text` less the one line terminator that ends it, so the printer's own newline does not leave a blank line. */
export function withoutTerminator(text: string): string {
  return text.replace(/\r?\n$/, "");
}
