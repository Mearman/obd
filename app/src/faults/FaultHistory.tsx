import {
  FAULT_SIGNALS,
  faultEvents,
  runFaultEventTable,
  type FaultEvent,
  type FaultList,
  type Run,
} from "obd-read";
import { useEffect, useState } from "react";
import { failureMessage, type DiagnosticsClient } from "../diagnostics/client";
import { error, muted, row, stack } from "../screens/screen.css";
import { DownloadMenu, tableDownload } from "../tabular/TableDownloads";
import { DataTable, type Column } from "../ui";

const LIST_NAMES: Readonly<Record<FaultList, string>> = {
  stored: "Stored",
  pending: "Pending",
  permanent: "Permanent",
};

function utc(timestamp: number): string {
  return `${new Date(timestamp).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`;
}

/** What happened to a code, in words: the colour of nothing carries it. */
function changeText(event: FaultEvent): string {
  if (event.change === "disappeared") return "Disappeared";
  return event.atStart ? "Present when collection began" : "Appeared";
}

const COLUMNS: readonly Column<FaultEvent>[] = [
  { header: "Time", render: (event) => utc(event.timestamp) },
  { header: "List", render: (event) => LIST_NAMES[event.list] },
  { header: "Code", render: (event) => event.code },
  { header: "Change", render: changeText },
];

/**
 * The changes in a run's fault codes: when each stored, pending or permanent code was first seen and when it was gone, with buttons to download them as the run's fault code events table. A run records the lists when it starts, every so often and when it stops, so a time is when a poll saw the change, not when the car set or cleared the code.
 *
 * @param refresh Changes whenever the run may have recorded new samples, so the history is read again.
 */
export function FaultHistory({
  client,
  run,
  refresh,
}: {
  readonly client: DiagnosticsClient;
  readonly run: Pick<Run, "id" | "startedAt">;
  readonly refresh?: unknown;
}) {
  const [events, setEvents] = useState<readonly FaultEvent[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const runId = run.id;

  useEffect(() => {
    const live = { active: true };
    void Promise.all(
      Object.values(FAULT_SIGNALS).map((signal) => client.runs.samples({ runId, signal })),
    ).then(
      (lists) => {
        if (!live.active) return;
        const samples = lists.flat().sort((a, b) => a.timestamp - b.timestamp);
        setEvents(faultEvents(samples));
      },
      (caught: unknown) => {
        if (live.active) setProblem(failureMessage(caught, "The fault codes could not be read."));
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, runId, refresh]);

  return (
    <div className={stack}>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {events?.length === 0 && (
        <p className={muted}>
          No fault codes were reported while this run collected, or it did not read them. Only a run
          of all the legislated values reads them.
        </p>
      )}
      {events !== undefined && events.length > 0 && (
        <>
          <DataTable
            label="Fault code changes"
            columns={COLUMNS}
            rows={events}
            rowKey={(event) =>
              `${String(event.timestamp)}-${event.list}-${event.code}-${event.change}`
            }
          />
          <span className={row}>
            <DownloadMenu
              tables={[
                tableDownload(
                  "fault code changes",
                  `obd-read-run-${runId}-fault-events`,
                  runFaultEventTable(run.startedAt),
                  events,
                ),
              ]}
            />
          </span>
        </>
      )}
    </div>
  );
}
