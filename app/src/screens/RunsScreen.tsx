import { useEffect, useState } from "react";
import type { RunSummary } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Badge, DataTable, type Column } from "../ui";
import { muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const COLUMNS: readonly Column<RunSummary>[] = [
  {
    header: "Started",
    render: (row) => new Date(row.startedAt).toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC",
  },
  { header: "Profile", render: (row) => row.profile },
  { header: "Samples", render: (row) => String(row.samples) },
  {
    header: "Source",
    render: (row) =>
      row.simulated ? <Badge tone="simulated">Simulated</Badge> : <Badge>Recorded</Badge>,
  },
];

/** Runs: the stored collection runs. */
export function RunsScreen() {
  const { client } = useDiagnostics();
  const [runs, setRuns] = useState<readonly RunSummary[] | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void client.runs().then((loaded) => {
      if (current) setRuns(loaded);
    });
    return () => {
      current = false;
    };
  }, [client]);

  return (
    <div className={page}>
      <ScreenHeading simulated={runs?.some((run) => run.simulated) === true}>Runs</ScreenHeading>
      {runs === undefined ? (
        <p className={muted}>Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className={muted}>No runs yet.</p>
      ) : (
        <DataTable label="Collection runs" columns={COLUMNS} rows={runs} rowKey={(row) => row.id} />
      )}
    </div>
  );
}
