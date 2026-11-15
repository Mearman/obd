import type { Sample } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Badge, Button, Card, DataTable, type Column } from "../ui";
import { COLLECTION_LIMIT } from "./limits";
import { error, muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const COLUMNS: readonly Column<Sample>[] = [
  { header: "Value", render: (row) => row.signal },
  { header: "Reading", render: (row) => String(row.value) },
  { header: "Unit", render: (row) => row.unit },
];

const STATE_LABEL = {
  collecting: "Collecting",
  reconnecting: "Reconnecting",
  failed: "Stopped by an error",
} as const;

/** Live values: start a collection run on the connection, watch the readings arrive and stop it. */
export function LiveScreen() {
  const { connection, collection, startCollection, stopCollection } = useDiagnostics();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const running = collection.run !== undefined;

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
        <p className={muted}>{COLLECTION_LIMIT}</p>
      </Card>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {collection.latest.length === 0 ? (
        <p className={muted}>
          {running ? "Waiting for the first reading…" : "Start collecting to see live values."}
        </p>
      ) : (
        <DataTable
          label="Live values"
          columns={COLUMNS}
          rows={collection.latest}
          rowKey={(row) => row.signal}
        />
      )}
    </div>
  );
}
