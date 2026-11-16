import {
  FAULT_CODE_TABLE,
  IDENTIFICATION_TABLE,
  faultCodeRows,
  identificationRows,
  obdFaultCodeRows,
  obdIdentificationRows,
  obdReportDocumentShareData,
  scanShareData,
  unitReportOf,
  type CodeDescriber,
  type FaultCodeRow,
  type IdentificationRow,
  type Json,
  type ScanReport,
} from "obd-read";
import { isObdRead } from "../library/saved-report";
import { useCodeDescriber } from "../profiles/code-describer";
import { TableDownloads } from "./TableDownloads";

/** The fault codes, each described by `describe`, and identification values a saved report holds, or `undefined` for a report with neither a per-unit scan nor an OBD-II read. */
function reportTables(
  report: Json,
  describe: CodeDescriber,
): { readonly faults: FaultCodeRow[]; readonly identification: IdentificationRow[] } | undefined {
  if (isObdRead(report)) {
    const read = obdReportDocumentShareData(report);
    return read.ok
      ? {
          faults: obdFaultCodeRows(read.value.obd, describe),
          identification: obdIdentificationRows(read.value.obd),
        }
      : undefined;
  }
  const scan = scanShareData(report);
  if (!scan.ok) return undefined;
  const units = scan.value.units.map(unitReportOf);
  return { faults: faultCodeRows(units, describe), identification: identificationRows(units) };
}

/** Download buttons for a saved report's fault codes and identification values, as CSV and TSV. A code's description comes from the describer the command line uses: the generic titles for an OBD-II read, the report's profile for a scan. The buttons appear once the descriptions are loaded. */
export function ReportDownloads({ report }: { readonly report: ScanReport }) {
  const generic = isObdRead(report.report);
  const describe = useCodeDescriber(generic ? null : report.profile, generic);
  if (describe === undefined) return null;
  const tables = reportTables(report.report, describe);
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
