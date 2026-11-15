import { EXPORT_FORMATS } from "obd-read";
import { useState } from "react";
import { failureMessage, type DiagnosticsClient } from "../diagnostics/client";
import { error, muted, row } from "../screens/screen.css";
import { runEnvelope } from "../screens/RunsScreen";
import { ShareDialog } from "../share/ShareDialog";
import { Badge, Button, Card, DataTable, download, type Column } from "../ui";
import { codesAtEnds, formatDuration, type PlanView, type ViewRecord } from "./plan-view";

const OUTCOME_TONE = {
  completed: "success",
  "timed-out": "warning",
  skipped: "neutral",
  failed: "warning",
  aborted: "warning",
} as const;

const PLAN_OUTCOME_TEXT = {
  completed: "The plan finished.",
  failed: "The plan stopped early",
  aborted: "The plan was aborted",
} as const;

/** The codes of one list in words. */
function codesText(codes: readonly string[]): string {
  return codes.length === 0 ? "none" : codes.join(", ");
}

/** A finished plan: how each phase ended and how long it took, the codes at the start and end, and the run's exports, share link and a way into Runs. */
export function PlanSummary({
  view,
  client,
  onOpenRun,
  onDone,
}: {
  readonly view: PlanView;
  readonly client: DiagnosticsClient;
  readonly onOpenRun: (runId: string) => void;
  /** Leaves the summary for the plan picker. */
  readonly onDone: () => void;
}) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const { end, runId } = view;
  if (end === undefined || runId === undefined) return null;
  const codes = codesAtEnds(view.reads);
  const columns: readonly Column<ViewRecord>[] = [
    {
      header: "Phase",
      render: (record) =>
        record.iteration > 1 ? `${record.title} (pass ${String(record.iteration)})` : record.title,
    },
    {
      header: "Outcome",
      render: (record) => <Badge tone={OUTCOME_TONE[record.outcome]}>{record.outcome}</Badge>,
    },
    { header: "Took", render: (record) => formatDuration(record.endedAt - record.startedAt) },
  ];
  const run = async (work: () => Promise<void>, failure: string): Promise<void> => {
    setProblem(undefined);
    try {
      await work();
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  };

  return (
    <Card title="Summary" {...(view.plan === undefined ? {} : { description: view.plan.title })}>
      <p role="status">
        {PLAN_OUTCOME_TEXT[end.outcome]}
        {end.reason === undefined || end.outcome === "completed" ? "" : `: ${end.reason}.`}
      </p>
      <DataTable
        label="Phases of the plan"
        columns={columns}
        rows={view.records}
        rowKey={(record) => `${record.phase}-${String(record.iteration)}`}
      />
      {codes.length === 0 ? (
        <p className={muted}>This plan read no fault code list.</p>
      ) : (
        <dl aria-label="Fault codes at the start and end">
          {codes.map((entry) => (
            <div key={entry.list}>
              <dt>{entry.list} codes</dt>
              <dd>
                At the start: {codesText(entry.start)}. At the end: {codesText(entry.end)}.
              </dd>
            </div>
          ))}
        </dl>
      )}
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      <span className={row}>
        <Button
          variant="primary"
          onClick={() => {
            onOpenRun(runId);
          }}
        >
          Open the run in Runs
        </Button>
        {EXPORT_FORMATS.map((format) => (
          <Button
            key={format}
            onClick={() =>
              void run(async () => {
                const file = await client.runs.export({ runId, format });
                download(file.filename, file.mediaType, file.content);
              }, "Could not export the run.")
            }
          >
            Export {format.toUpperCase()}
          </Button>
        ))}
        <ShareDialog
          label="Share"
          title="Share this run's summary"
          load={async () => runEnvelope(client, await client.runs.get({ runId }))}
        />
        <Button variant="ghost" onClick={onDone}>
          Record another
        </Button>
      </span>
    </Card>
  );
}
