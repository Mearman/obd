import type { Run } from "obd-read";
import { isSimulatorUrl } from "obd-read";
import { useCallback, useEffect, useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Badge, Button, DataTable, type Column } from "../ui";
import { error, muted, page, row } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

/** A stored run with the number of samples it holds. */
interface RunRow {
  readonly run: Run;
  readonly samples: number;
}

/** Saves `content` as a file the user downloads. */
function download(filename: string, mediaType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Runs: the stored collection runs, with export and, for an open run, resume. */
export function RunsScreen() {
  const { service, collection, runsVersion, resumeCollection, stopCollection } = useDiagnostics();
  const { client } = service;
  const [rows, setRows] = useState<readonly RunRow[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const collectingId = collection.run?.id;

  useEffect(() => {
    const live = { active: true };
    void (async () => {
      const runs = await client.runs.list({});
      const loaded = await Promise.all(
        runs.map(async (run) => ({
          run,
          samples: (await client.runs.aggregate({ runId: run.id })).reduce(
            (total, signal) => total + signal.count,
            0,
          ),
        })),
      );
      if (live.active) setRows(loaded);
    })();
    return () => {
      live.active = false;
    };
  }, [client, runsVersion, collection.latest.length]);

  const act = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    setProblem(undefined);
    try {
      await work();
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  }, []);

  const columns: readonly Column<RunRow>[] = [
    {
      header: "Started",
      render: ({ run }) =>
        new Date(run.startedAt).toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC",
    },
    { header: "Profile", render: ({ run }) => run.profile },
    { header: "Samples", render: ({ samples }) => String(samples) },
    {
      header: "State",
      render: ({ run }) =>
        run.id === collectingId ? (
          <Badge tone="success">Collecting</Badge>
        ) : run.stoppedAt === null ? (
          <Badge tone="warning">Open</Badge>
        ) : (
          <Badge>Stopped</Badge>
        ),
    },
    {
      header: "Source",
      render: ({ run }) =>
        isSimulatorUrl(run.adapter) ? (
          <Badge tone="simulated">Simulated</Badge>
        ) : (
          <Badge>Recorded</Badge>
        ),
    },
    {
      header: "Actions",
      render: ({ run }) => (
        <span className={row}>
          {run.stoppedAt === null && run.id !== collectingId && (
            <Button
              onClick={() => void act(() => resumeCollection(run), "Could not resume the run.")}
            >
              Resume
            </Button>
          )}
          {run.id === collectingId && (
            <Button onClick={() => void act(stopCollection, "Could not stop the run.")}>
              Stop
            </Button>
          )}
          {(["csv", "json"] as const).map((format) => (
            <Button
              key={format}
              onClick={() =>
                void act(async () => {
                  const file = await client.runs.export({ runId: run.id, format });
                  download(file.filename, file.mediaType, file.content);
                }, "Could not export the run.")
              }
            >
              Export {format.toUpperCase()}
            </Button>
          ))}
        </span>
      ),
    },
  ];

  return (
    <div className={page}>
      <ScreenHeading simulated={rows?.some(({ run }) => isSimulatorUrl(run.adapter)) === true}>
        Runs
      </ScreenHeading>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {rows === undefined ? (
        <p className={muted}>Loading runs…</p>
      ) : rows.length === 0 ? (
        <p className={muted}>No runs yet.</p>
      ) : (
        <DataTable
          label="Collection runs"
          columns={columns}
          rows={rows}
          rowKey={({ run }) => run.id}
        />
      )}
    </div>
  );
}
