import {
  FAULT_CODE_TABLE,
  IDENTIFICATION_TABLE,
  OBD_REPORT_FORMAT,
  faultCodeRows,
  identificationRows,
  obdFaultCodeRows,
  obdIdentificationRows,
  obdReportDocumentShareData,
  scanShareData,
  unitReportOf,
  type FaultCodeRow,
  type IdentificationRow,
  type Json,
  type ScanReport,
} from "obd-read";
import { TableDownloads } from "./TableDownloads";

/** The fault codes and identification values a saved report holds, or `undefined` for a report with neither a per-unit scan nor an OBD-II read. */
function reportTables(
  report: Json,
): { readonly faults: FaultCodeRow[]; readonly identification: IdentificationRow[] } | undefined {
  const isObdRead =
    typeof report === "object" &&
    report !== null &&
    !Array.isArray(report) &&
    report.format === OBD_REPORT_FORMAT;
  if (isObdRead) {
    const read = obdReportDocumentShareData(report);
    return read.ok
      ? {
          faults: obdFaultCodeRows(read.value.obd),
          identification: obdIdentificationRows(read.value.obd),
        }
      : undefined;
  }
  const scan = scanShareData(report);
  if (!scan.ok) return undefined;
  const units = scan.value.units.map(unitReportOf);
  return { faults: faultCodeRows(units), identification: identificationRows(units) };
}

/** Download buttons for a saved report's fault codes and identification values, as CSV and TSV. */
export function ReportDownloads({ report }: { readonly report: ScanReport }) {
  const tables = reportTables(report.report);
  if (tables === undefined) return null;
  return (
    <>
      <TableDownloads
        label="fault codes"
        filename={`${report.id}-fault-codes`}
        spec={FAULT_CODE_TABLE}
        rows={tables.faults}
      />
      <TableDownloads
        label="identification"
        filename={`${report.id}-identification`}
        spec={IDENTIFICATION_TABLE}
        rows={tables.identification}
      />
    </>
  );
}
