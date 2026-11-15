/**
 * The two links of the plan sharing loop: a `plan` link sends a recording plan to someone to record, and a `plan-result` link sends what they recorded back, with the whole plan in it so it reads without the plan at hand.
 *
 * This module builds and describes both kinds; the schemas and the link format are in `share.ts`. It is platform-free.
 */

import { FAULT_SIGNALS, faultEvents } from "./fault-history.js";
import {
  describeCondition,
  describePlanVersion,
  planDigest,
  planIdentity,
  PLAN_READS,
  type Plan,
  type PlanPhase,
  type PlanRead,
} from "./plan.js";
import {
  PLAN_PHASE_SIGNAL,
  PLAN_SIGNAL,
  describeWait,
  planOfRun,
  planPhases,
} from "./plan-runner.js";
import {
  MAX_CODE_EVENTS,
  MAX_SHARED_PASSES,
  SHARE_VERSION,
  aggregateSamples,
  describeSharedRun,
  runSummaryShareData,
  type PlanResultShareData,
  type ShareEnvelope,
} from "./share.js";
import type { Run, Sample, SignalAggregate } from "./storage.js";

/** The signals a plan result carries in its own fields, so they are left out of its run summary. */
const STRUCTURED_SIGNALS: ReadonlySet<string> = new Set([
  PLAN_SIGNAL,
  PLAN_PHASE_SIGNAL,
  ...Object.values(FAULT_SIGNALS),
]);

function isPlanRead(read: string): read is PlanRead {
  return PLAN_READS.some((known) => known === read);
}

/** The envelope of a `plan` link for a validated plan. */
export function planEnvelope(plan: Plan, createdAt: number): ShareEnvelope {
  return { v: SHARE_VERSION, kind: "plan", createdAt, data: { plan } };
}

/**
 * The data of a `plan-result` link for a recorded run of `plan`: the run's summary without the signals carried structurally, each phase pass with its reads, and every fault code change, with times as milliseconds since the run started.
 *
 * `samples` need not be sorted.
 */
export function planResultShareData(
  plan: Plan,
  run: Pick<Run, "profile" | "adapter" | "startedAt" | "stoppedAt" | "notes">,
  aggregates: readonly SignalAggregate[],
  samples: readonly Sample[],
): PlanResultShareData {
  const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const offset = (at: number): number => Math.max(0, at - run.startedAt);
  return {
    plan,
    planHash: planDigest(plan),
    redacted: false,
    run: runSummaryShareData(
      run,
      aggregates.filter((aggregate) => !STRUCTURED_SIGNALS.has(aggregate.signal)),
      ordered.filter((sample) => !STRUCTURED_SIGNALS.has(sample.signal)),
    ),
    phases: planPhases(ordered)
      .slice(0, MAX_SHARED_PASSES)
      .map((record) => ({
        phase: record.phase,
        title: record.title,
        iteration: record.iteration,
        start: offset(record.startedAt),
        end: offset(record.endedAt),
        outcome: record.outcome,
        // The runner stores only the reads a plan names, so any other is not a read of this plan.
        reads: record.reads.flatMap((read) =>
          isPlanRead(read.read)
            ? [{ read: read.read, when: read.when, at: offset(read.at), result: read.result }]
            : [],
        ),
      })),
    codeEvents: faultEvents(ordered)
      .slice(0, MAX_CODE_EVENTS)
      .map((event) => ({
        at: offset(event.timestamp),
        list: event.list,
        code: event.code,
        change: event.change === "appeared" ? "appeared" : "cleared",
        atStart: event.atStart,
      })),
  };
}

/**
 * The envelope that shares a stored run: a `plan-result` when the run recorded the plan it followed, else a `run-summary`. Aggregates are computed from `samples` when not given.
 */
export function runShareEnvelope(
  run: Pick<Run, "profile" | "adapter" | "startedAt" | "stoppedAt" | "notes">,
  samples: readonly Sample[],
  createdAt: number,
  aggregates: readonly SignalAggregate[] = aggregateSamples(samples),
): ShareEnvelope {
  const recorded = planOfRun(samples);
  if (recorded === undefined) {
    return {
      v: SHARE_VERSION,
      kind: "run-summary",
      createdAt,
      data: runSummaryShareData(run, aggregates, samples),
    };
  }
  return {
    v: SHARE_VERSION,
    kind: "plan-result",
    createdAt,
    data: planResultShareData(recorded.plan, run, aggregates, samples),
  };
}

function iterationsOf(phase: PlanPhase): string {
  const repeat = phase.repeat;
  if (repeat === undefined) return "";
  return "times" in repeat
    ? `, ${String(repeat.times)} times`
    : `, until ${describeCondition(repeat.until)}, at most ${String(repeat.max)} times`;
}

/** The lines `plan show` prints for one plan: its name, version, safety text, values and each phase. */
export function describePlan(plan: Plan): string[] {
  const lines = [
    `${plan.name}: ${plan.title}`,
    `version: ${describePlanVersion(planIdentity(plan))}`,
    plan.description,
  ];
  if (plan.safety !== undefined) lines.push(`safety: ${plan.safety}`);
  lines.push(
    `source: ${plan.source}`,
    `values: ${plan.needs.values === "all" ? "every value the car supports" : plan.needs.values.join(", ")}`,
  );
  if (plan.needs.profile !== undefined) lines.push(`profile: ${plan.needs.profile}`);
  plan.phases.forEach((phase, index) => {
    lines.push("");
    lines.push(`phase ${String(index + 1)}: ${phase.id}, ${phase.title}${iterationsOf(phase)}`);
    lines.push(`  ${phase.instruction}`);
    const every =
      phase.sample.every === "fastest"
        ? "as fast as the adapter allows"
        : `every ${String(phase.sample.every)} s`;
    lines.push(`  samples ${phase.sample.values?.join(", ") ?? "the plan's values"} ${every}`);
    if (phase.start !== undefined) lines.push(`  starts when ${describeWait(phase.start)}`);
    lines.push(`  ends when ${describeWait(phase.end)}`);
    if (phase.reads.start.length > 0)
      lines.push(`  reads at start: ${phase.reads.start.join(", ")}`);
    if (phase.reads.end.length > 0) lines.push(`  reads at end: ${phase.reads.end.join(", ")}`);
    if (phase.watchCodes) lines.push("  watches the fault code lists throughout");
  });
  return lines;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** The lines of a shared plan result: the plan's version, each phase pass with its reads, the code changes, the plan itself and the run summary. */
export function describeSharedPlanResult(data: PlanResultShareData, createdAt: number): string[] {
  const lines = [
    `shared plan result for ${data.plan.name} (${data.plan.title}), ${describePlanVersion({ revision: data.plan.revision ?? 1, hash: data.planHash })}`,
    data.redacted
      ? "VIN-shaped text in the notes and freeze frames was removed before sharing"
      : "VIN-shaped text in the notes and freeze frames is included",
  ];
  for (const pass of data.phases) {
    const which = pass.iteration > 1 ? ` (pass ${String(pass.iteration)})` : "";
    lines.push(
      `phase ${pass.phase}${which}, ${pass.title}: ${pass.outcome}, from ${seconds(pass.start)} to ${seconds(pass.end)}`,
    );
    for (const read of pass.reads) {
      const result = read.result;
      const text =
        result.kind === "codes"
          ? `${result.list} codes ${result.units.flatMap((unit) => unit.codes).join(", ") || "none"}`
          : result.kind === "freeze-frame"
            ? `freeze frame ${result.units.map((unit) => unit.code ?? "no code").join(", ") || "none"}`
            : result.kind === "misfire-counters"
              ? `misfire counters from ${String(result.units.length)} units`
              : `failed: ${result.error}`;
      lines.push(`  ${read.read} at the ${read.when}, ${seconds(read.at)}: ${text}`);
    }
  }
  for (const event of data.codeEvents) {
    lines.push(
      `code ${event.code} ${event.change} in the ${event.list} list at ${seconds(event.at)}${event.atStart ? " (there from the start)" : ""}`,
    );
  }
  lines.push("", "the plan:", ...describePlan(data.plan).map((line) => `  ${line}`), "");
  lines.push(...describeSharedRun(data.run, createdAt));
  return lines;
}
