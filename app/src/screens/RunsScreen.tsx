import {
  EXPORT_FORMATS,
  allowsWrites,
  isSimulatorUrl,
  runSummaryShareData,
  type Run,
  type Sample,
  type ShareEnvelope,
} from "obd-read";
import { useCallback, useEffect, useState } from "react";
import { profileTitle } from "../profiles/generic";
import { failureMessage, type DiagnosticsClient } from "../diagnostics/client";
import { useDatabase } from "../database/DatabaseProvider";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { OriginBadge } from "../origin/OriginBadge";
import { ALL_ORIGINS, ORIGIN_FILTER_OPTIONS, originQuery } from "../origin/origins";
import { Badge, Button, DataTable, Dialog, Select, download, type Column } from "../ui";
import { error, muted, page, row } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";
import { FaultHistory } from "../faults/FaultHistory";
import { ShareDialog } from "../share/ShareDialog";
import { RunGraphs } from "./RunGraphs";
import { RunImport } from "./RunImport";

/** A stored run with the number of samples it holds. */
interface RunRow {
  readonly run: Run;
  readonly samples: number;
}

/** How many samples one read of a run's samples asks for. */
const PAGE = 5000;

/** The envelope that shares `run`: its aggregates and a thinned series, read from the service when the user asks to share. */
export async function runEnvelope(client: DiagnosticsClient, run: Run): Promise<ShareEnvelope> {
  const aggregates = await client.runs.aggregate({ runId: run.id });
  const samples: Sample[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.runs.samples({ runId: run.id, limit: PAGE, offset });
    samples.push(...page);
    if (page.length < PAGE) break;
  }
  return {
    v: 1,
    kind: "run-summary",
    createdAt: Date.now(),
    data: runSummaryShareData(run, aggregates, samples),
  };
}

/** Runs: the stored collection runs, with export and, for an open run, resume. `open` names a run whose graphs to show, as when another screen sends the person here. */
export function RunsScreen({ open }: { readonly open?: string | undefined }) {
  const { service, collection, runsVersion, resumeCollection, stopCollection } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const [rows, setRows] = useState<readonly RunRow[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState(ALL_ORIGINS);
  const [graphed, setGraphed] = useState<Run | undefined>(undefined);
  // Changes when a run is imported, so the list is read again.
  const [imported, setImported] = useState(0);
  const collectingId = collection.run?.id;

  useEffect(() => {
    const live = { active: true };
    void (async () => {
      const runs = await client.runs.list(originQuery(shown));
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
  }, [client, runsVersion, collection.latest.length, shown, imported, revision]);

  useEffect(() => {
    if (open === undefined) return;
    const live = { active: true };
    void client.runs.get({ runId: open }).then((run) => {
      if (live.active) setGraphed(run);
    });
    return () => {
      live.active = false;
    };
  }, [client, open]);

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
    { header: "Profile", render: ({ run }) => profileTitle(run.profile) },
    { header: "Samples", render: ({ samples }) => String(samples) },
    {
      header: "State",
      render: ({ run }) =>
        run.id === collectingId ? (
          <Badge tone="success">{collection.stopping ? "Stopping…" : "Collecting"}</Badge>
        ) : run.stoppedAt === null ? (
          <Badge tone="warning">Open</Badge>
        ) : (
          <Badge>Stopped</Badge>
        ),
    },
    {
      header: "Source",
      render: ({ run }) => (
        <span className={row}>
          <OriginBadge origin={run.origin} />
          {isSimulatorUrl(run.adapter) ? (
            <Badge tone="simulated">Simulated</Badge>
          ) : (
            <Badge>Recorded</Badge>
          )}
        </span>
      ),
    },
    {
      header: "Actions",
      render: ({ run }) => (
        <span className={row}>
          {allowsWrites(run.origin) && run.stoppedAt === null && run.id !== collectingId && (
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
          <Button
            aria-pressed={graphed?.id === run.id}
            onClick={() => {
              setGraphed(graphed?.id === run.id ? undefined : run);
            }}
          >
            View graphs
          </Button>
          <Dialog
            trigger={<Button aria-label={`Fault codes of run ${run.id}`}>Fault codes</Button>}
            title="Fault codes"
            description="When each fault code appeared or disappeared while this run collected."
          >
            <FaultHistory client={client} runId={run.id} />
          </Dialog>
          <ShareDialog
            label="Share"
            title="Share this run's summary"
            load={() => runEnvelope(client, run)}
          />
          {EXPORT_FORMATS.map((format) => (
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
      <RunImport
        onImported={() => {
          setImported((count) => count + 1);
        }}
      />
      <Select
        label="Show runs"
        value={shown}
        options={ORIGIN_FILTER_OPTIONS}
        onValueChange={setShown}
      />
      {rows === undefined ? (
        <p className={muted}>Loading runs…</p>
      ) : rows.length === 0 ? (
        <p className={muted}>
          {shown === ALL_ORIGINS ? "No runs yet." : "No runs of this origin."}
        </p>
      ) : (
        <DataTable
          label="Collection runs"
          columns={columns}
          rows={rows}
          rowKey={({ run }) => run.id}
        />
      )}
      {graphed !== undefined && (
        <RunGraphs
          key={graphed.id}
          client={client}
          run={graphed}
          onClose={() => {
            setGraphed(undefined);
          }}
        />
      )}
    </div>
  );
}
