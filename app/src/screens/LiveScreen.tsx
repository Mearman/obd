import type { Sample } from "obd-read";
import { useState } from "react";
import { LineChart, appendRolling, type RollingHistory } from "../charts";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { FaultHistory } from "../faults/FaultHistory";
import { Badge, Button, Card, DataTable, type Column } from "../ui";
import { COLLECTION_LIMIT } from "./limits";
import { error, muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

/** How many readings of each value the trend keeps. */
const TREND_READINGS = 120;

const STATE_LABEL = {
  collecting: "Collecting",
  reconnecting: "Reconnecting",
  failed: "Stopped by an error",
} as const;

/** Live values: start a collection run on the connection, watch the readings arrive and stop it. */
export function LiveScreen() {
  const { connection, collection, service, startCollection, stopCollection } = useDiagnostics();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const running = collection.run !== undefined;
  const runId = collection.run?.id;
  // Adjusted while rendering, as React advises for state derived from a changing input: a new run
  // starts an empty history, and each new set of latest readings is folded into the one kept.
  const [tracked, setTracked] = useState<{
    readonly runId: string | undefined;
    readonly latest: readonly Sample[];
    readonly history: RollingHistory;
  }>({ runId, latest: [], history: new Map() });
  if (tracked.runId !== runId || tracked.latest !== collection.latest) {
    setTracked({
      runId,
      latest: collection.latest,
      history: appendRolling(
        tracked.runId === runId ? tracked.history : new Map(),
        collection.latest,
        TREND_READINGS,
      ),
    });
  }
  const { history } = tracked;

  const columns: readonly Column<Sample>[] = [
    { header: "Value", render: (row) => row.signal },
    { header: "Reading", render: (row) => String(row.value) },
    { header: "Unit", render: (row) => row.unit },
    {
      header: "Trend",
      render: (row) => (
        <LineChart
          variant="compact"
          name={row.signal}
          unit={row.unit}
          points={history.get(row.signal) ?? []}
        />
      ),
    },
  ];

  async function toggle(): Promise<void> {
    setBusy(true);
    setProblem(undefined);
    try {
      if (running) await stopCollection();
      else await startCollection();
    } catch (caught) {
      setProblem(failureMessage(caught, running ? "Could not stop the run." : "Could not start."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Live values</ScreenHeading>
      <Card
        title="Collection"
        description="A run stores every reading, so it can be exported afterwards. The screen is kept awake while it runs."
      >
        <div>
          {collection.state !== undefined && (
            <Badge tone={collection.state === "failed" ? "warning" : "success"}>
              {STATE_LABEL[collection.state]}
            </Badge>
          )}
        </div>
        <Button
          variant="primary"
          block
          disabled={connection === undefined || busy}
          onClick={() => void toggle()}
        >
          {running ? "Stop collecting" : "Start collecting"}
        </Button>
        {connection === undefined && <p className={muted}>Connect an adapter first.</p>}
        {collection.lastError !== null && collection.state !== "collecting" && (
          <p className={muted}>{collection.lastError}</p>
        )}
        {connection?.profile === null && (
          <p className={muted}>
            This connection has no profile, so a run collects the legislated values the car says it
            supports.
          </p>
        )}
        <p className={muted}>{COLLECTION_LIMIT}</p>
      </Card>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {collection.run !== undefined && collection.latest.length > 0 && (
        <Card
          title="Fault codes"
          description="Read when the run starts, every so often and when it stops."
        >
          <FaultHistory
            client={service.client}
            runId={collection.run.id}
            refresh={collection.latest
              .filter((sample) => sample.signal.endsWith("fault codes"))
              .map((sample) => sample.timestamp)
              .join()}
          />
        </Card>
      )}
      {collection.latest.length === 0 ? (
        <p className={muted}>
          {running ? "Waiting for the first reading…" : "Start collecting to see live values."}
        </p>
      ) : (
        <DataTable
          label="Live values"
          columns={columns}
          rows={collection.latest}
          rowKey={(row) => row.signal}
        />
      )}
    </div>
  );
}
