import {
  DEFAULT_SWEEP_BUDGET,
  DEFAULT_SWEEP_PAUSE_MS,
  MAX_SWEEP_BUDGET,
  MIN_SWEEP_PAUSE_MS,
  type CaptureStatus,
} from "obd-read";
import { useId, useRef, useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { error, muted, optionGrid, stack } from "../screens/screen.css";
import { Badge, Button, Card, Switch, TextField } from "../ui";

/** What the identifier sweep warning says, wherever a sweep can be turned on. */
export const SWEEP_WARNING =
  "An identifier sweep reads every data identifier in the range from each unit that answered, one request at a time. It can send thousands of requests; some units answer slowly, and some log the requests. It only reads, and it stops at its budget or when you press Stop.";

/** A number typed as decimal or as `0x` hexadecimal, or `undefined` when it is neither. */
function typedNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * The Capture action: records every raw request and reply the read-only services give on the open connection, so it can be decoded later under any profile. An identifier sweep is off unless switched on, with its warning shown.
 *
 * @param onSaved Called with the capture's id once it is stored.
 */
export function CaptureCard({ onSaved }: { readonly onSaved?: (id: string) => void }) {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const [status, setStatus] = useState<CaptureStatus | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [sweep, setSweep] = useState(false);
  const [first, setFirst] = useState("0x00");
  const [last, setLast] = useState("0xFF");
  const [budget, setBudget] = useState(String(DEFAULT_SWEEP_BUDGET));
  const [pause, setPause] = useState(String(DEFAULT_SWEEP_PAUSE_MS));
  const warningId = useId();
  const current = useRef<string | undefined>(undefined);

  const capturing = status?.state === "capturing";
  const free = connection !== undefined && collection.run === undefined && !capturing;

  async function start(): Promise<void> {
    setProblem(undefined);
    let identifiers;
    if (sweep) {
      const range = {
        first: typedNumber(first),
        last: typedNumber(last),
        budget: typedNumber(budget),
        pauseMs: typedNumber(pause),
      };
      if (
        range.first === undefined ||
        range.last === undefined ||
        range.budget === undefined ||
        range.pauseMs === undefined
      ) {
        setProblem("Give the sweep's range, budget and pause as whole numbers.");
        return;
      }
      identifiers = {
        first: range.first,
        last: range.last,
        budget: range.budget,
        pauseMs: range.pauseMs,
      };
    }
    try {
      const started = await client.captures.start(identifiers === undefined ? {} : { identifiers });
      current.current = started.id;
      setStatus(started);
      for await (const update of await client.captures.progress({ id: started.id })) {
        if (current.current !== started.id) break;
        setStatus(update);
        if (update.state === "saved") onSaved?.(update.id);
      }
    } catch (caught) {
      setProblem(failureMessage(caught, "The capture could not start."));
    }
  }

  async function stop(): Promise<void> {
    if (status === undefined) return;
    try {
      setStatus(await client.captures.stop({ id: status.id }));
    } catch (caught) {
      setProblem(failureMessage(caught, "The capture could not be stopped."));
    }
  }

  return (
    <Card
      title="Capture everything"
      description={
        connection?.profile === null
          ? "Records every raw request and reply: the legislated OBD-II reads, then a short sweep of request identifiers to find units and read their identification and fault codes. It only reads. Open the capture on Captures to decode it under any profile, now or later."
          : `Records every raw request and reply: the legislated OBD-II reads and every unit of ${connection?.profile ?? "the profile"}. It only reads. Open the capture on Captures to decode it under any profile, now or later.`
      }
    >
      <div className={stack}>
        <Switch
          label="Also sweep data identifiers (many requests)"
          checked={sweep}
          onCheckedChange={setSweep}
          disabled={capturing}
        />
        {sweep && (
          <>
            <p id={warningId} role="note" className={error}>
              {SWEEP_WARNING}
            </p>
            <div className={optionGrid}>
              <TextField label="First identifier" value={first} onValueChange={setFirst} />
              <TextField label="Last identifier" value={last} onValueChange={setLast} />
              <TextField
                label={`Request budget (at most ${String(MAX_SWEEP_BUDGET)})`}
                value={budget}
                onValueChange={setBudget}
                inputMode="numeric"
              />
              <TextField
                label={`Pause between requests, ms (at least ${String(MIN_SWEEP_PAUSE_MS)})`}
                value={pause}
                onValueChange={setPause}
                inputMode="numeric"
              />
            </div>
          </>
        )}
        {capturing ? (
          <Button block onClick={() => void stop()} disabled={status.stopping}>
            {status.stopping ? "Stopping…" : "Stop capture"}
          </Button>
        ) : (
          <Button
            variant="primary"
            block
            disabled={!free}
            onClick={() => void start()}
            {...(sweep ? { "aria-describedby": warningId } : {})}
          >
            Capture everything
          </Button>
        )}
        {connection === undefined && <p className={muted}>Connect an adapter first.</p>}
        <div role="status" aria-live="polite">
          {status !== undefined && (
            <p>
              <Badge
                tone={
                  status.state === "failed"
                    ? "danger"
                    : status.state === "saved"
                      ? "success"
                      : "neutral"
                }
              >
                {status.state === "capturing"
                  ? "Capturing"
                  : status.state === "saved"
                    ? "Saved"
                    : "Failed"}
              </Badge>{" "}
              {status.state === "saved" && status.summary !== null
                ? `${String(status.summary.exchanges)} exchanges from ${String(status.summary.units.length)} addresses${status.summary.complete ? "" : ", stopped before it finished"}. Open it on Captures.`
                : `${String(status.exchanges)} exchanges so far. ${status.detail}`}
            </p>
          )}
        </div>
        {(problem ?? status?.error ?? undefined) !== undefined && (
          <p role="alert" className={error}>
            {problem ?? status?.error}
          </p>
        )}
      </div>
    </Card>
  );
}
