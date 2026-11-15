import {
  OBD_REPORT_FORMAT,
  obdReportDocumentShareData,
  scanShareData,
  unitReportOf,
  type Json,
  type ScanReport,
  type ScanReportSummary,
} from "obd-read";
import { useEffect, useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { OriginBadge } from "../origin/OriginBadge";
import { ALL_ORIGINS, ORIGIN_FILTER_OPTIONS, originQuery } from "../origin/origins";
import { profileTitle } from "../profiles/generic";
import { Button, Card, DataTable, Select, type Column } from "../ui";
import { ObdReport } from "./ObdReport";
import { FaultCodesTable, ScanResultsTable } from "./ScanResults";
import { error, muted, row, stack } from "./screen.css";

/** What the open report's origin means, in a sentence. */
const ORIGIN_NOTES: Readonly<Record<ScanReport["origin"], (report: ScanReport) => string>> = {
  local: (report) => `Read here through ${report.adapter}.`,
  shared: () => "Shared data from a link, not read from your adapter.",
  imported: () => "Imported from a file, not read here.",
};

function isObdRead(report: Json): boolean {
  return (
    typeof report === "object" &&
    report !== null &&
    !Array.isArray(report) &&
    report.format === OBD_REPORT_FORMAT
  );
}

/** One saved report, read-only: a generic OBD-II read with the Scan screen's report, a scan with its units and fault codes. Nothing here acts on the car or changes the report. */
function SavedReport({ report }: { readonly report: ScanReport }) {
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

/**
 * The saved scan reports and OBD-II reads, newest first, each with a badge saying whether it was read here, saved from a share link or imported, and a filter by that origin. A report opens read-only.
 */
export function SavedReports({
  refresh,
}: {
  /** Changes whenever a report may have been saved, so the list is read again. */
  readonly refresh: unknown;
}) {
  const { service } = useDiagnostics();
  const { client } = service;
  const [shown, setShown] = useState(ALL_ORIGINS);
  const [reports, setReports] = useState<readonly ScanReportSummary[] | undefined>(undefined);
  const [open, setOpen] = useState<ScanReport | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    const live = { active: true };
    void client.reports.list(originQuery(shown)).then(
      (listed) => {
        if (live.active) setReports(listed);
      },
      (caught: unknown) => {
        if (live.active) setProblem(failureMessage(caught, "The saved reports could not be read."));
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, shown, refresh]);

  async function view(id: string): Promise<void> {
    setProblem(undefined);
    try {
      setOpen(await client.reports.get({ id }));
    } catch (caught) {
      setProblem(failureMessage(caught, "The report could not be read."));
    }
  }

  const columns: readonly Column<ScanReportSummary>[] = [
    {
      header: "Taken",
      render: (report) =>
        `${new Date(report.takenAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`,
    },
    { header: "Profile", render: (report) => profileTitle(report.profile) },
    { header: "Label", render: (report) => report.label || "-" },
    { header: "Origin", render: (report) => <OriginBadge origin={report.origin} /> },
    {
      header: "Actions",
      render: (report) => (
        <Button aria-label={`View report ${report.id}`} onClick={() => void view(report.id)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="Saved reports"
      description="Every scan, OBD-II read and snapshot kept on this device, including those saved from a share link."
    >
      <div className={stack}>
        <Select
          label="Show reports"
          value={shown}
          options={ORIGIN_FILTER_OPTIONS}
          onValueChange={setShown}
        />
        {problem !== undefined && (
          <p role="alert" className={error}>
            {problem}
          </p>
        )}
        {reports?.length === 0 && (
          <p className={muted}>
            {shown === ALL_ORIGINS ? "No saved reports yet." : "No saved reports of this origin."}
          </p>
        )}
        {reports !== undefined && reports.length > 0 && (
          <DataTable
            label="Saved reports"
            columns={columns}
            rows={reports}
            rowKey={(report) => report.id}
          />
        )}
        {open !== undefined && (
          <div className={stack} aria-label="Saved report">
            <div className={row}>
              <OriginBadge origin={open.origin} />
              <span className={muted}>{ORIGIN_NOTES[open.origin](open)}</span>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(undefined);
                }}
              >
                Close
              </Button>
            </div>
            <SavedReport report={open} />
          </div>
        )}
      </div>
    </Card>
  );
}
