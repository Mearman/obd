/**
 * What the Guide screen shows of a running plan, folded from the service's plan events.
 *
 * The fold is pure, so the screen re-reads the same view whenever it subscribes again: the service replays the events so far, and the frequent samples and progress only as the latest of the phase.
 */

import type { PlanEventData } from "obd-read";

type EventOf<Type extends PlanEventData["type"]> = Extract<PlanEventData, { readonly type: Type }>;

/** The plan as the events carry it. */
export type ViewPlan = EventOf<"plan-started">["plan"];

/** One phase of the plan. */
export type ViewPhase = EventOf<"phase-started">["phase"];

/** One reading of the latest sample. */
export type ViewReading = EventOf<"sample">["readings"][number];

/** One finished pass of a phase. */
export type ViewRecord = EventOf<"phase-finished">["record"];

/** One read a phase took. */
export type ViewRead = EventOf<"read">["record"];

/** Something worth telling the person mid-phase: a fault code appeared or cleared, or a wait ran out. */
export interface PlanNotice {
  readonly at: number;
  readonly text: string;
}

/** The phase running. */
export interface CurrentPhase {
  readonly index: number;
  readonly iteration: number;
  readonly iterations: number;
  readonly phase: ViewPhase;
}

/** The wait the phase is in. */
export interface CurrentWait {
  readonly stage: "start" | "end";
  readonly condition: string;
  readonly timeoutMs: number;
}

/** How the plan ended. */
export interface PlanEnd {
  readonly at: number;
  readonly outcome: EventOf<"finished">["outcome"];
  readonly reason: string | undefined;
}

/** What the screen shows of one plan. */
export interface PlanView {
  readonly runId: string | undefined;
  readonly plan: ViewPlan | undefined;
  readonly startedAt: number | undefined;
  readonly current: CurrentPhase | undefined;
  readonly wait: CurrentWait | undefined;
  readonly progress: { readonly text: string; readonly elapsedMs: number } | undefined;
  /** The question the current wait asks the person, or undefined when it asks none. */
  readonly confirm: string | undefined;
  readonly readings: readonly ViewReading[];
  readonly notices: readonly PlanNotice[];
  readonly records: readonly ViewRecord[];
  readonly reads: readonly ViewRead[];
  readonly end: PlanEnd | undefined;
}

/** The view before any event. */
export const EMPTY_VIEW: PlanView = {
  runId: undefined,
  plan: undefined,
  startedAt: undefined,
  current: undefined,
  wait: undefined,
  progress: undefined,
  confirm: undefined,
  readings: [],
  notices: [],
  records: [],
  reads: [],
  end: undefined,
};

/** The view after `event`. */
export function planView(view: PlanView, event: PlanEventData): PlanView {
  switch (event.type) {
    case "plan-started":
      return { ...EMPTY_VIEW, runId: event.runId, plan: event.plan, startedAt: event.at };
    case "phase-started":
      return {
        ...view,
        current: {
          index: event.index,
          iteration: event.iteration,
          iterations: event.iterations,
          phase: event.phase,
        },
        wait: undefined,
        progress: undefined,
        confirm: undefined,
        readings: [],
      };
    case "waiting":
      return {
        ...view,
        wait: { stage: event.stage, condition: event.condition, timeoutMs: event.timeoutMs },
        progress: undefined,
      };
    case "sample":
      return { ...view, readings: event.readings };
    case "progress":
      return { ...view, progress: { text: event.progress, elapsedMs: event.elapsedMs } };
    case "confirm-requested":
      return { ...view, confirm: event.prompt };
    case "condition-met":
      return { ...view, confirm: undefined };
    case "condition-timed-out":
      return {
        ...view,
        confirm: undefined,
        notices: [
          ...view.notices,
          {
            at: event.at,
            text: `Timed out waiting for the phase to ${event.stage === "start" ? "start" : "end"}; ${event.onTimeout === "skip" ? "going on to the next phase" : "the plan stops"}.`,
          },
        ],
      };
    case "code-appeared":
    case "code-cleared":
      return {
        ...view,
        notices: [
          ...view.notices,
          {
            at: event.at,
            text: `${event.code} ${event.type === "code-appeared" ? "appeared in" : "cleared from"} the ${event.list} codes.`,
          },
        ],
      };
    case "read":
      return { ...view, reads: [...view.reads, event.record] };
    case "phase-finished":
      return { ...view, confirm: undefined, records: [...view.records, event.record] };
    case "finished":
      return {
        ...view,
        confirm: undefined,
        end: { at: event.at, outcome: event.outcome, reason: event.reason },
      };
  }
}

/** A length of time in words: seconds to one decimal place under a minute, else minutes and whole seconds. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  // Rounded once, so 599.9 s reads as 10 min 0 s and never as 9 min 60 s.
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))} min ${String(whole % 60)} s`;
}

/** A moment as the clock time in UTC and the offset since the plan started. */
export function formatMoment(at: number, startedAt: number | undefined): string {
  const clock = new Date(at).toLocaleTimeString("en-GB", { timeZone: "UTC" });
  return startedAt === undefined
    ? `${clock} UTC`
    : `${clock} UTC (+${formatDuration(at - startedAt)})`;
}

/** The fault codes each list held at the plan's first and last read of it. */
export interface CodesAtEnds {
  readonly list: string;
  readonly start: readonly string[];
  readonly end: readonly string[];
}

/** The codes at the first and last read of each code list the plan read, in the order first read. */
export function codesAtEnds(reads: readonly ViewRead[]): CodesAtEnds[] {
  const byList = new Map<string, { start: string[]; end: string[] }>();
  for (const read of reads) {
    if (read.result.kind !== "codes") continue;
    const found = read.result.units.flatMap((unit) =>
      unit.codes.map((code) => `${code} (${unit.unit})`),
    );
    const seen = byList.get(read.result.list);
    if (seen === undefined) byList.set(read.result.list, { start: found, end: found });
    else seen.end = found;
  }
  return [...byList].map(([list, { start, end }]) => ({ list, start, end }));
}

/** The condition the phase's current wait waits for, or undefined outside a wait. */
export function waitCondition(
  current: CurrentPhase | undefined,
  wait: CurrentWait | undefined,
): ViewPhase["end"]["when"] | undefined {
  if (current === undefined || wait === undefined) return undefined;
  return wait.stage === "start" ? current.phase.start?.when : current.phase.end.when;
}

/** The length of the phase's wait in milliseconds when it is a plain countdown, else undefined. */
export function countdownMs(
  current: CurrentPhase | undefined,
  wait: CurrentWait | undefined,
): number | undefined {
  const when = waitCondition(current, wait);
  return when?.kind === "elapsed" ? when.seconds * 1000 : undefined;
}
