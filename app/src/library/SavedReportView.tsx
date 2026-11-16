import { obdReportDocumentShareData, scanShareData, unitReportOf, type ScanReport } from "obd-read";
import { OriginBadge } from "../origin/OriginBadge";
import { ObdReport } from "../screens/ObdReport";
import { FaultCodesTable, ScanResultsTable } from "../screens/ScanResults";
import { muted, row, stack } from "../screens/screen.css";
import { ReportDownloads } from "../tabular/ReportDownloads";
import { isObdRead } from "./saved-report";
import { Button, download } from "../ui";

/** What the open report's origin means, in a sentence. */
const ORIGIN_NOTES: Readonly<Record<ScanReport["origin"], (report: ScanReport) => string>> = {
  local: (report) => `Read here through ${report.adapter}.`,
  shared: () => "Shared data from a link, not read from your adapter.",
  imported: () => "Imported from a file, not read here.",
};

/** One saved report's body, read-only: a generic OBD-II read with the report the Session screen's Read section shows, a scan with its units and fault codes. Nothing here acts on the car or changes the report. */
function SavedReportBody({ report }: { readonly report: ScanReport }) {
  if (isObdRead(report.report)) {
    const read = obdReportDocumentShareData(report.report);
    return read.ok ? (
      <ObdReport scan={read.value.obd} />
    ) : (
      <p className={muted}>This OBD-II read cannot be shown: {read.error.message}.</p>
    );
  }
  const scan = scanShareData(report.report);
  if (!scan.ok) return <p className={muted}>This report has no per-unit scan to show.</p>;
  const units = scan.value.units.map(unitReportOf);
  return (
    <>
      <ScanResultsTable label={`Saved scan ${report.label || report.id}`} units={units} />
      <FaultCodesTable label="Saved fault codes" units={units} />
    </>
  );
}

/** An open saved report: its origin, its downloads and its body, with a button that closes it. */
export function SavedReportView({
  report,
  onClose,
}: {
  readonly report: ScanReport;
  readonly onClose: () => void;
}) {
  return (
    <div className={stack} aria-label="Saved report">
      <div className={row}>
        <OriginBadge origin={report.origin} />
        <span className={muted}>{ORIGIN_NOTES[report.origin](report)}</span>
        <Button
          onClick={() => {
            download(
              `${report.id}.json`,
              "application/json",
              `${JSON.stringify(report.report, null, 2)}\n`,
            );
          }}
        >
          Download JSON
        </Button>
        <ReportDownloads report={report} />
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <SavedReportBody report={report} />
    </div>
  );
}
