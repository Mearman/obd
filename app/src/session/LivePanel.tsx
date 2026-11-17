import type { Sample } from "obd-read";
import { useMemo, useState } from "react";
import { LineChart } from "../charts";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { useActivity } from "../pwa/ActivityProvider";
import { FaultHistory } from "../faults/FaultHistory";
import { formatReading } from "../format/reading";
import { SATURATED_NOTE, isSaturated } from "../format/saturation";
import { Badge, Button, Card, DataTable, TextField, type Column } from "../ui";
import { groupRows } from "../screens/live/groups";
import { groupHeading, groups, note } from "../screens/live/live.css";
import { initialSelection, sameSelection } from "../screens/live/presets";
import { readPins, readSelection, writePins, writeSelection } from "../screens/live/remembered";
import { useSupportedValues } from "../screens/live/useSupportedValues";
import { ValuePicker } from "../screens/live/ValuePicker";
import { COLLECTION_LIMIT } from "../screens/limits";
import { error, muted } from "../screens/screen.css";

const PINNED = "Pinned";

const STATE_LABEL = {
  collecting: "Collecting",
  reconnecting: "Reconnecting",
  failed: "Stopped by an error",
} as const;

/** The Live section: choose values, start a collection run on the connection, watch the readings arrive and stop it. */
export function LivePanel() {
  const { connection, collection, service, startCollection, stopCollection } = useDiagnostics();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useActivity("starting or stopping a run", busy);
  const running = collection.run !== undefined;
  const stopping = collection.stopping;
  const supportedState = useSupportedValues(connection, !running);
  const supported = supportedState.status === "ready" ? supportedState.supported : undefined;
  const supportedNames = useMemo(
    () => supported?.values.map((value) => value.name) ?? [],
    [supported],
  );
  // The person's own choice once made; until then what was remembered, else the Engine preset.
  const [chosen, setChosen] = useState<readonly string[] | undefined>(undefined);
  const selected = useMemo(
    () => chosen ?? initialSelection(readSelection(), supportedNames),
    [chosen, supportedNames],
  );
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<readonly string[]>(readPins);
  const { history } = collection;

  const columns: readonly Column<Sample>[] = [
    { header: "Value", render: (row) => row.signal },
    {
      header: "Reading",
      render: (row) => (
        <>
          {formatReading(row.value, row.unit)}
          {isSaturated(row.signal, row.value) && <span className={note}>{SATURATED_NOTE}</span>}
        </>
      ),
    },
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
    {
      header: "Pin",
      bare: true,
      render: (row) => {
        const pinned = pins.includes(row.signal);
        return (
          <Button
            variant={pinned ? "primary" : "secondary"}
            aria-pressed={pinned}
            aria-label={`${pinned ? "Unpin" : "Pin"} ${row.signal}`}
            onClick={() => {
              const next = pinned
                ? pins.filter((label) => label !== row.signal)
                : [...pins, row.signal];
              setPins(next);
              writePins(next);
            }}
          >
            {pinned ? "Pinned" : "Pin"}
          </Button>
        );
      },
    },
  ];

  const shown = collection.latest.filter((sample) =>
    sample.signal.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pinnedRows = shown.filter((sample) => pins.includes(sample.signal));
  const sections = [
    ...(pinnedRows.length > 0 ? [{ title: PINNED, rows: pinnedRows }] : []),
    ...groupRows(
      shown.filter((sample) => !pins.includes(sample.signal)),
      (sample) => sample.signal,
    ).map(({ group, rows }) => ({ title: group, rows })),
  ];

  function choose(names: readonly string[]): void {
    setChosen(names);
    writeSelection(names);
  }

  async function toggle(): Promise<void> {
    setBusy(true);
    setProblem(undefined);
    try {
      if (running) await stopCollection();
      else {
        // Everything the car supports is a run of no named values, which also reads the fault codes.
        const everything = sameSelection(selected, supportedNames);
        await startCollection(everything ? undefined : selected);
      }
    } catch (caught) {
      setProblem(failureMessage(caught, running ? "Could not stop the run." : "Could not start."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Collection"
        description="A run stores every reading, so it can be exported afterwards. The screen is kept awake while it runs."
      >
        <div>
          {collection.state !== undefined && (
            <Badge tone={collection.state === "failed" ? "warning" : "success"}>
              {stopping ? "Stopping…" : STATE_LABEL[collection.state]}
            </Badge>
          )}
        </div>
        {!running && supported !== undefined && (
          <ValuePicker supported={supported} selected={selected} onSelectedChange={choose} />
        )}
        {!running && supportedState.status === "loading" && (
          <p className={muted}>Reading which values the car supports…</p>
        )}
        {!running && supportedState.status === "failed" && (
          <p role="alert" className={error}>
            {supportedState.message}
          </p>
        )}
        <Button
          variant="primary"
          block
          disabled={
            connection === undefined ||
            busy ||
            stopping ||
            (!running && (supported === undefined || selected.length === 0))
          }
          onClick={() => void toggle()}
        >
          {stopping ? "Stopping…" : running ? "Stop collecting" : "Start collecting"}
        </Button>
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
            run={collection.run}
            refresh={collection.latest
              .filter((sample) => sample.signal.endsWith("fault codes"))
              .map((sample) => sample.timestamp)
              .join()}
          />
        </Card>
      )}
      {collection.latest.length === 0 ? (
        <p className={muted} role="status">
          {!running
            ? "Start collecting to see live values."
            : collection.progress === null
              ? "Waiting for the first reading…"
              : `Reading value ${String(collection.progress.position)} of ${String(collection.progress.total)}: ${collection.progress.label}`}
        </p>
      ) : (
        <>
          <TextField label="Search values" value={query} onValueChange={setQuery} />
          {sections.length === 0 && <p className={muted}>No value matches the search.</p>}
          <div className={groups}>
            {sections.map(({ title, rows }) => (
              <section key={title} aria-label={title}>
                <h2 className={groupHeading}>{title}</h2>
                <DataTable
                  label={`Live values: ${title}`}
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.signal}
                />
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}
