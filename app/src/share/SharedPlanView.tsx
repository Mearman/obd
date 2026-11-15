import {
  describePlanVersion,
  faultSampleValue,
  type PlanResultShareData,
  type PlanShareData,
} from "obd-read";
import { useMemo, useState } from "react";
import { formatDuration } from "../guide/plan-view";
import { PlanPreview } from "../guide/PlanPreview";
import { RunPlayer } from "../screens/RunGraphs";
import type { RunSeries, SeriesSummary } from "../screens/run-series";
import { muted, stack } from "../screens/screen.css";
import type { Series } from "../charts";
import { Badge, Button, Card, DataTable } from "../ui";

const OUTCOME_TONE = {
  completed: "success",
  "timed-out": "warning",
  skipped: "neutral",
  failed: "warning",
  aborted: "warning",
} as const;

/** The version label of a shared plan: its revision and the start of its digest. */
function versionOf(plan: PlanShareData["plan"], hash: string): string {
  return describePlanVersion({ revision: plan.revision ?? 1, hash });
}

/** Props of {@link SharedPlanView}. */
export interface SharedPlanViewProps {
  readonly data: PlanShareData;
  /** The plan's digest, shown as its version. */
  readonly hash: string;
  /** Saves the plan to My plans and opens the Guide on it, ready to record; undefined while the database is not open. */
  readonly onOpenInGuide: (() => void) | undefined;
}

/** A plan from a link, read-only: its title, version, safety text, description and every phase as the person recording will see it, with Open in Guide. It only reads the car; nothing in a plan clears, writes or actuates. */
export function SharedPlanView({ data, hash, onOpenInGuide }: SharedPlanViewProps) {
  const { plan } = data;
  return (
    <Card
      title={plan.title}
      description={`Plan ${plan.name}, ${versionOf(plan, hash)}. Source: ${plan.source}`}
    >
      <p className={muted}>
        A recording plan someone sent you. It only reads the car: no step clears codes, writes or
        actuates anything. Open it in Guide to record it with your adapter, then send the results
        back with the link the summary offers.
      </p>
      <PlanPreview plan={plan} />
      <div>
        <Button variant="primary" disabled={onOpenInGuide === undefined} onClick={onOpenInGuide}>
          Open in Guide
        </Button>
      </div>
    </Card>
  );
}

/** The plan result's readings as the run graphs take them, on an axis of milliseconds since the run started. */
export function resultSeries(data: PlanResultShareData): RunSeries {
  const { run, signals } = data.run;
  const end = Math.max(
    1,
    run.stoppedAt === null ? 0 : run.stoppedAt - run.startedAt,
    ...data.phases.map((pass) => pass.end),
    ...signals.flatMap((signal) => signal.series.map(([at]) => at)),
  );
  const series: Series[] = signals
    .filter((signal) => signal.series.length > 0)
    .map((signal) => ({
      key: `${signal.signal}\u0000${signal.unit}`,
      signal: signal.signal,
      unit: signal.unit,
      points: signal.series.map(([t, v]) => ({ t, v })),
    }));
  const summaries = new Map<string, SeriesSummary>(
    signals.map((signal) => [
      `${signal.signal}\u0000${signal.unit}`,
      { readings: signal.count, min: signal.min, max: signal.max },
    ]),
  );
  return { series, summaries, domain: [0, end], textReadings: 0 };
}

function seconds(milliseconds: number): string {
  return formatDuration(milliseconds);
}

/** Props of {@link PlanResultView}. */
export interface PlanResultViewProps {
  readonly data: PlanResultShareData;
  /** Saves the plan the result carries to My plans; undefined while the database is not open. */
  readonly onSavePlan: (() => void) | undefined;
  /** Whether the plan has been saved to My plans from this view. */
  readonly planSaved: boolean;
}

/**
 * What someone recorded with a plan, read-only and complete without the plan at hand: the plan's title and version, the plan itself, each phase pass with how it ended, when and the reads it took, the fault codes that appeared or cleared, and the readings graphed on one time axis with each phase's start marked on every chart.
 */
export function PlanResultView({ data, onSavePlan, planSaved }: PlanResultViewProps) {
  const [showPlan, setShowPlan] = useState(false);
  const series = useMemo(() => resultSeries(data), [data]);
  const markers = useMemo(
    () =>
      data.phases.map((pass) => ({
        at: pass.start,
        label: pass.iteration > 1 ? `${pass.title} ${String(pass.iteration)}` : pass.title,
      })),
    [data.phases],
  );
  const { plan, run } = data;
  return (
    <div className={stack}>
      <Card
        title={`Results of ${plan.title}`}
        description={`Plan ${plan.name}, ${versionOf(plan, data.planHash)}. Recorded with profile ${run.run.profile} through ${run.run.adapter}, started ${new Date(run.run.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC. ${data.redacted ? "The sender removed VIN-shaped text." : "VIN-shaped text is included."}`}
      >
        <div>
          <Badge>{versionOf(plan, data.planHash)}</Badge>
        </div>
        <DataTable
          label="Phases of the shared result"
          columns={[
            {
              header: "Phase",
              render: (pass) =>
                pass.iteration > 1 ? `${pass.title} (pass ${String(pass.iteration)})` : pass.title,
            },
            {
              header: "Outcome",
              render: (pass) => <Badge tone={OUTCOME_TONE[pass.outcome]}>{pass.outcome}</Badge>,
            },
            { header: "From", render: (pass) => seconds(pass.start) },
            { header: "To", render: (pass) => seconds(pass.end) },
            {
              header: "Reads",
              render: (pass) =>
                pass.reads.length === 0
                  ? "-"
                  : pass.reads
                      .map((read) => {
                        const result = read.result;
                        const text =
                          result.kind === "codes"
                            ? faultSampleValue(result.units.flatMap((unit) => unit.codes))
                            : result.kind === "freeze-frame"
                              ? result.units.map((unit) => unit.code ?? "no code").join(", ") ||
                                "none"
                              : result.kind === "misfire-counters"
                                ? `${String(result.units.length)} units`
                                : `failed: ${result.error}`;
                        return `${read.read} at the ${read.when}: ${text}`;
                      })
                      .join("; "),
            },
          ]}
          rows={data.phases}
          rowKey={(pass) => `${pass.phase}-${String(pass.iteration)}`}
        />
        {data.codeEvents.length === 0 ? (
          <p className={muted}>No fault code appeared or cleared.</p>
        ) : (
          <DataTable
            label="Fault code changes"
            columns={[
              { header: "Code", render: (event) => event.code },
              { header: "List", render: (event) => event.list },
              {
                header: "Change",
                render: (event) => (event.atStart ? "there from the start" : event.change),
              },
              { header: "At", render: (event) => seconds(event.at) },
            ]}
            rows={data.codeEvents}
            rowKey={(event) => `${event.list}-${event.code}-${String(event.at)}-${event.change}`}
          />
        )}
        <div>
          <Button
            aria-expanded={showPlan}
            onClick={() => {
              setShowPlan((value) => !value);
            }}
          >
            {showPlan ? "Hide the plan" : "Show the plan"}
          </Button>{" "}
          <Button disabled={onSavePlan === undefined || planSaved} onClick={onSavePlan}>
            {planSaved ? "Saved to my plans" : "Save this plan to my plans"}
          </Button>
        </div>
        {showPlan && <PlanPreview plan={plan} />}
      </Card>
      <Card title="Graphs" description="Each phase's start is marked on every chart.">
        {series.series.length === 0 ? (
          <p className={muted}>The result has no numeric readings to chart.</p>
        ) : (
          <RunPlayer data={series} markers={markers} />
        )}
      </Card>
    </div>
  );
}
