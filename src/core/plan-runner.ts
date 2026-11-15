/**
 * Running a recording plan: phase by phase, sampling the plan's values, taking its reads, waiting for its conditions and recording everything as an ordinary stored run.
 *
 * {@link PlanRunner} drives one plan over a {@link PlanLink} (a `DeviceLink` is one) into a {@link Storage}, and reports what it does as {@link PlanEvent}s, so a command line and a page show the same steps. It reads the car only through the read-only legislated OBD-II functions (`readPid`, `codes`, `freezeFrame`, `misfireCounts`), each of which passes the guard; nothing in a plan can clear, write or actuate. It reads no clock of its own: time and waiting come from an injected {@link PlanClock}, so a test runs a plan of minutes in no time.
 *
 * The run holds three kinds of sample. Each reading is a sample whose signal is the value's label, as a collection run stores it. Each fault code list is a text sample, written whenever the list changes, under the signal and in the format collection runs use (`FAULT_SIGNALS`, `faultSampleValue`), so `faultEvents` turns either kind of run into code events. Each phase is one text sample under {@link PLAN_PHASE_SIGNAL}, at the phase's start time, whose value is the JSON of its {@link PhaseRecord}: start and end times, outcome and the reads. {@link planPhases} reads them back. Because they are ordinary samples, the exports, the share link and the run screens carry them with no change to storage.
 *
 * This module is platform-free.
 */

import { z } from "zod";
import { isCommandError } from "./command-errors.js";
import { FAULT_LISTS, FAULT_SIGNALS, faultSampleValue, type FaultList } from "./fault-history.js";
import type { Elm } from "./elm.js";
import { buildSource, type Source } from "./live.js";
import { GENERIC_PROFILE } from "./generic.js";
import { OptionError } from "./options.js";
import {
  PENDING_CODES,
  PERMANENT_CODES,
  STORED_CODES,
  codes,
  freezeFrame,
  misfireCounts,
} from "./obd.js";
import { PIDS } from "./pids.js";
import {
  DEFAULT_CODE_WATCH_INTERVAL_S,
  conditionsIn,
  describeCondition,
  phaseValues,
  watchesCodes,
  type Plan,
  type PlanPhase,
  type PlanRead,
  type PlanWait,
} from "./plan.js";
import { ConditionTracker, confirmPrompt, type Observation } from "./plan-condition.js";
import type { Sample, Storage } from "./storage.js";
import { now as clockNow, sleep as clockSleep } from "./time.js";

/** The connection a plan runs on: one piece of work at a time, as {@link DeviceLink.withSession} gives it. */
export interface PlanLink {
  withSession<T>(work: (session: { readonly elm: Elm }) => Promise<T>): Promise<T>;
}

/** Time and waiting, injected so a test can run a plan on a fake clock. */
export interface PlanClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `milliseconds`; the runner may stop waiting earlier. */
  sleep(milliseconds: number): Promise<void>;
}

/** The real clock. */
export const systemClock: PlanClock = { now: clockNow, sleep: clockSleep };

/** The signal a phase's record is stored under. */
export const PLAN_PHASE_SIGNAL = "plan phase";

/** The one place a fault code list becomes a stored sample, in the format collection runs use (see fault-history.ts), so `faultEvents` reads either kind of run. */
function faultListSample(
  runId: string,
  list: FaultList,
  found: readonly string[],
  timestamp: number,
): Sample {
  return {
    runId,
    signal: FAULT_SIGNALS[list],
    unit: "",
    timestamp,
    value: faultSampleValue(found),
  };
}

const CODE_MODES: Readonly<Record<FaultList, number>> = {
  stored: STORED_CODES,
  pending: PENDING_CODES,
  permanent: PERMANENT_CODES,
};

const READ_LISTS: Readonly<Partial<Record<PlanRead, FaultList>>> = {
  "stored-codes": "stored",
  "pending-codes": "pending",
  "permanent-codes": "permanent",
};

/** A unit's address as hexadecimal, as the reports print it. */
function unitKey(sender: number): string {
  return sender.toString(16).toUpperCase();
}

/** The result of one read, by answering unit. */
export const readResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("codes"),
    list: z.enum(FAULT_LISTS),
    units: z.array(z.object({ unit: z.string(), codes: z.array(z.string()) })),
  }),
  z.object({
    kind: z.literal("freeze-frame"),
    units: z.array(
      z.object({
        unit: z.string(),
        code: z.string().nullable(),
        values: z.record(z.string(), z.string()),
      }),
    ),
  }),
  z.object({
    kind: z.literal("misfire-counters"),
    units: z.array(
      z.object({
        unit: z.string(),
        monitors: z.array(
          z.object({
            monitor: z.number(),
            averageLastTenCycles: z.number().nullable(),
            lastCycle: z.number().nullable(),
          }),
        ),
      }),
    ),
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);

/** The result of one read. */
export type ReadResult = z.output<typeof readResultSchema>;

/** One read a phase took. */
export const readRecordSchema = z.object({
  read: z.string(),
  when: z.enum(["start", "end"]),
  at: z.number(),
  result: readResultSchema,
});

/** One read a phase took. */
export type ReadRecord = z.output<typeof readRecordSchema>;

/** How a phase ended. */
export const PHASE_OUTCOMES = ["completed", "timed-out", "skipped", "failed", "aborted"] as const;

/** How a phase ended. */
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

/** The stored record of one pass of one phase. */
export const phaseRecordSchema = z.object({
  phase: z.string(),
  title: z.string(),
  /** Which pass of a repeated phase, from 1. */
  iteration: z.number().int().positive(),
  startedAt: z.number(),
  endedAt: z.number(),
  outcome: z.enum(PHASE_OUTCOMES),
  reads: z.array(readRecordSchema),
});

/** The stored record of one pass of one phase. */
export type PhaseRecord = z.output<typeof phaseRecordSchema>;

/** The phase records in a run's samples, in time order; a sample that does not hold a valid record is ignored. */
export function planPhases(samples: readonly Sample[]): PhaseRecord[] {
  return samples.flatMap((sample) => {
    if (sample.signal !== PLAN_PHASE_SIGNAL || typeof sample.value !== "string") return [];
    let data: unknown;
    try {
      data = JSON.parse(sample.value);
    } catch {
      return [];
    }
    const parsed = phaseRecordSchema.safeParse(data);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Which wait of a phase an event is about. */
export type WaitStage = "start" | "end";

/** One reading in a {@link PlanEvent} `sample`. */
export interface PlanReading {
  /** The value name, as the plan names it. */
  readonly name: string;
  readonly label: string;
  readonly unit: string;
  /** `undefined` where the value was not read this time. */
  readonly value: number | string | undefined;
}

/** What a running plan reports, in order. */
export type PlanEvent =
  | {
      readonly type: "plan-started";
      readonly at: number;
      readonly runId: string;
      readonly plan: Plan;
    }
  | {
      readonly type: "phase-started";
      readonly at: number;
      readonly phase: PlanPhase;
      readonly index: number;
      readonly iteration: number;
      /** The passes the phase repeats for: fixed, or at most this many. */
      readonly iterations: number;
    }
  | {
      readonly type: "waiting";
      readonly at: number;
      readonly phase: string;
      readonly stage: WaitStage;
      /** The condition in words. */
      readonly condition: string;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "sample";
      readonly at: number;
      readonly phase: string;
      readonly readings: readonly PlanReading[];
    }
  | {
      readonly type: "progress";
      readonly at: number;
      readonly phase: string;
      readonly stage: WaitStage;
      readonly progress: string;
      readonly elapsedMs: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "condition-met";
      readonly at: number;
      readonly phase: string;
      readonly stage: WaitStage;
    }
  | {
      readonly type: "condition-timed-out";
      readonly at: number;
      readonly phase: string;
      readonly stage: WaitStage;
      readonly onTimeout: PlanWait["onTimeout"];
    }
  | {
      readonly type: "confirm-requested";
      readonly at: number;
      readonly phase: string;
      readonly stage: WaitStage;
      readonly prompt: string;
    }
  | {
      readonly type: "code-appeared" | "code-cleared";
      readonly at: number;
      readonly phase: string;
      readonly list: FaultList;
      readonly code: string;
    }
  | {
      readonly type: "read";
      readonly at: number;
      readonly phase: string;
      readonly record: ReadRecord;
    }
  | { readonly type: "phase-finished"; readonly at: number; readonly record: PhaseRecord }
  | {
      readonly type: "finished";
      readonly at: number;
      readonly runId: string;
      readonly outcome: PlanOutcome;
      /** Why the plan failed or was aborted; absent when it completed. */
      readonly reason?: string;
    };

/** How a plan ended. */
export type PlanOutcome = "completed" | "failed" | "aborted";

/** What {@link PlanRunner.run} returns. */
export interface PlanResult {
  readonly runId: string;
  readonly outcome: PlanOutcome;
  readonly reason?: string;
  readonly phases: readonly PhaseRecord[];
}

/** What {@link PlanRunner} needs. */
export interface PlanRunnerOptions {
  readonly plan: Plan;
  readonly link: PlanLink;
  readonly storage: Storage;
  /** The adapter's URL or label, stored on the run. */
  readonly adapter: string;
  /** The profile the run is stored for; omitted, the plan's, else the generic OBD-II profile. */
  readonly profile?: string;
  /** The CAN identifier width of the legislated reads. Default 11. */
  readonly idBits?: 11 | 29;
  /** The CAN bit rate of the legislated reads. Default 500000. */
  readonly bitrate?: number;
  /** Default: the real clock. */
  readonly clock?: PlanClock;
  /** The gap between reads of the fault code lists while a phase watches them. Default {@link DEFAULT_CODE_WATCH_INTERVAL_S}. */
  readonly codesIntervalMs?: number;
  /** Called with each event, in order. */
  readonly onEvent?: (event: PlanEvent) => void;
  /** The run's notes. Default {@link planRunNotes} of the plan. */
  readonly notes?: string;
}

/** The notes a plan's run is stored with unless the caller gives its own. */
export function planRunNotes(plan: Pick<Plan, "name" | "title">): string {
  return `plan ${plan.name}: ${plan.title}`;
}

/** How many samples are buffered before they are stored. */
const FLUSH_SIZE = 50;

/** A request from outside the run loop, acted on at its next step. */
type Interrupt = "skip" | "abort";

/** Raised inside the loop to end the plan; never escapes {@link PlanRunner.run}. */
class PlanStopped extends Error {
  override name = "PlanStopped";

  constructor(
    readonly outcome: "failed" | "aborted",
    reason: string,
  ) {
    super(reason);
  }
}

/** What a wait ended with. */
type WaitEnd = "met" | "timed-out" | "skipped";

/** A source with the value name of each column. */
interface NamedSource {
  readonly source: Source;
  readonly names: readonly string[];
}

/**
 * Runs one plan, once. Create a runner, subscribe with `onEvent`, call {@link run}; call {@link confirm}, {@link skipPhase} or {@link abort} at any time while it runs.
 */
export class PlanRunner {
  private readonly clock: PlanClock;
  private readonly codesIntervalMs: number;
  private readonly sources = new Map<string, NamedSource>();
  private readonly lastCodes = new Map<FaultList, readonly string[]>();
  private readonly pending: Sample[] = [];
  private readonly phases: PhaseRecord[] = [];
  private runId = "";
  private interrupt: Interrupt | undefined;
  private wake: () => void = () => undefined;
  private tracker: ConditionTracker | undefined;
  private untilTracker: ConditionTracker | undefined;
  private awaitingConfirm = false;
  private lastCodesAt: number | undefined;
  private started = false;

  constructor(private readonly options: PlanRunnerOptions) {
    this.clock = options.clock ?? systemClock;
    this.codesIntervalMs = options.codesIntervalMs ?? DEFAULT_CODE_WATCH_INTERVAL_S * 1000;
  }

  /** Answers the confirmation the current wait asked for; does nothing when none is asked. */
  confirm(): void {
    if (!this.awaitingConfirm || this.tracker === undefined) return;
    this.awaitingConfirm = false;
    this.tracker.observe({ type: "confirmed", at: this.clock.now() });
    this.wake();
  }

  /** Ends the current phase as skipped, after its end reads, and goes on to the next. */
  skipPhase(): void {
    this.interrupt ??= "skip";
    this.wake();
  }

  /** Ends the plan at its next step, without further reads; the run is still stored and stopped. */
  abort(): void {
    this.interrupt = "abort";
    this.wake();
  }

  /**
   * Runs the plan to its end and stores it as a run, stopped when the plan ends however it ends.
   *
   * Before the run is created every phase's values are checked against what the car supports, so a plan the car cannot satisfy fails at once.
   *
   * @throws OptionError when the car does not support a value the plan needs; no run is created.
   * @throws The errors the adapter layers raise while the values are checked, before any run exists. Once the run exists, an adapter or unit error ends the plan as `failed` and is returned, not thrown.
   */
  async run(): Promise<PlanResult> {
    if (this.started) throw new Error("a plan runner runs once");
    this.started = true;
    const { plan, storage } = this.options;
    await this.prepareSources();
    const run = await storage.createRun({
      profile: this.options.profile ?? plan.needs.profile ?? GENERIC_PROFILE,
      adapter: this.options.adapter,
      startedAt: this.clock.now(),
      notes: this.options.notes ?? planRunNotes(plan),
    });
    this.runId = run.id;
    this.emit({ type: "plan-started", at: run.startedAt, runId: run.id, plan });
    let outcome: PlanOutcome = "completed";
    let reason: string | undefined;
    try {
      for (const [index, phase] of plan.phases.entries()) await this.runPhase(phase, index);
    } catch (error) {
      if (error instanceof PlanStopped) {
        outcome = error.outcome;
        reason = error.message;
      } else if (isCommandError(error)) {
        outcome = "failed";
        reason = error.message;
      } else {
        throw error;
      }
    } finally {
      await this.flush();
      await storage.stopRun(run.id, this.clock.now());
    }
    this.emit({
      type: "finished",
      at: this.clock.now(),
      runId: run.id,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
    return {
      runId: run.id,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      phases: this.phases,
    };
  }

  private emit(event: PlanEvent): void {
    this.options.onEvent?.(event);
  }

  /** Builds one source per distinct value list and checks every value a condition tests is among them. */
  private async prepareSources(): Promise<void> {
    const { plan } = this.options;
    for (const phase of plan.phases) {
      const values = phaseValues(plan, phase);
      const named = await this.sourceFor(values);
      const waits = [phase.start?.when, phase.end.when].filter((when) => when !== undefined);
      const tested = waits
        .flatMap(conditionsIn)
        .flatMap((condition) => (condition.kind === "value" ? [condition.value] : []));
      const missing = tested.filter((name) => !named.names.includes(name));
      if (missing.length > 0) {
        throw new OptionError(
          `phase ${phase.id} waits on ${missing.join(", ")}, which the car does not report; it reports: ${named.source.available.join(", ")}`,
        );
      }
    }
  }

  private async sourceFor(values: readonly string[] | "all"): Promise<NamedSource> {
    const key = values === "all" ? "all" : values.join(",");
    const cached = this.sources.get(key);
    if (cached !== undefined) return cached;
    const wanted = values === "all" ? [] : values;
    const source = await this.options.link.withSession(({ elm }) =>
      buildSource(
        elm,
        undefined,
        {
          values: wanted,
          idBits: this.options.idBits ?? 11,
          bitrate: this.options.bitrate ?? 500_000,
        },
        () => undefined,
      ),
    );
    const byName = new Map([...PIDS.values()].map((pid) => [pid.name, pid]));
    const chosen = wanted.length > 0 ? wanted : source.available;
    const names = chosen.flatMap((name) => (byName.get(name)?.columns ?? []).map(() => name));
    const named = { source, names };
    this.sources.set(key, named);
    return named;
  }

  private async runPhase(phase: PlanPhase, index: number): Promise<void> {
    const repeat = phase.repeat;
    const iterations = repeat === undefined ? 1 : "times" in repeat ? repeat.times : repeat.max;
    this.untilTracker =
      repeat !== undefined && "until" in repeat
        ? new ConditionTracker(repeat.until, this.clock.now(), this.lastCodes)
        : undefined;
    for (let iteration = 1; iteration <= iterations; iteration++) {
      await this.runPass(phase, index, iteration, iterations);
      if (this.untilTracker?.status(this.clock.now()).met === true) break;
    }
    this.untilTracker = undefined;
  }

  private async runPass(
    phase: PlanPhase,
    index: number,
    iteration: number,
    iterations: number,
  ): Promise<void> {
    const startedAt = this.clock.now();
    this.emit({ type: "phase-started", at: startedAt, phase, index, iteration, iterations });
    const reads: ReadRecord[] = [];
    const finish = async (outcome: PhaseOutcome): Promise<void> => {
      const record: PhaseRecord = {
        phase: phase.id,
        title: phase.title,
        iteration,
        startedAt,
        endedAt: this.clock.now(),
        outcome,
        reads,
      };
      this.phases.push(record);
      this.pending.push({
        runId: this.runId,
        signal: PLAN_PHASE_SIGNAL,
        unit: "",
        timestamp: startedAt,
        value: JSON.stringify(record),
      });
      await this.flush();
      this.emit({ type: "phase-finished", at: record.endedAt, record });
    };
    try {
      if (phase.start !== undefined) {
        const began = await this.wait(phase, "start", phase.start);
        if (began !== "met") {
          await finish(began);
          this.interrupt = undefined;
          if (began === "timed-out" && phase.start.onTimeout === "fail") {
            throw new PlanStopped("failed", `phase ${phase.id} timed out waiting to start`);
          }
          return;
        }
      }
      for (const read of phase.reads.start) reads.push(await this.read(phase, read, "start"));
      const ended = await this.wait(phase, "end", phase.end);
      this.interrupt = undefined;
      for (const read of phase.reads.end) reads.push(await this.read(phase, read, "end"));
      await finish(ended === "met" ? "completed" : ended);
      if (ended === "timed-out" && phase.end.onTimeout === "fail") {
        throw new PlanStopped(
          "failed",
          `phase ${phase.id} timed out waiting for ${describeCondition(phase.end.when)}`,
        );
      }
    } catch (error) {
      if (error instanceof PlanStopped) {
        if (error.outcome === "aborted") await finish("aborted");
        throw error;
      }
      if (isCommandError(error)) await finish("failed");
      throw error;
    }
  }

  /** Throws {@link PlanStopped} when the plan was aborted. */
  private checkAbort(): void {
    if (this.interrupt === "abort") throw new PlanStopped("aborted", "aborted");
  }

  /** Samples and watches until the wait's condition holds, it runs out or the person skips. */
  private async wait(phase: PlanPhase, stage: WaitStage, wait: PlanWait): Promise<WaitEnd> {
    const watching = watchesCodes(phase);
    if (watching) await this.readFaultLists(phase.id);
    const startedAt = this.clock.now();
    const timeoutMs = wait.timeout * 1000;
    const tracker = new ConditionTracker(wait.when, startedAt, this.lastCodes);
    this.tracker = tracker;
    this.emit({
      type: "waiting",
      at: startedAt,
      phase: phase.id,
      stage,
      condition: describeCondition(wait.when),
      timeoutMs,
    });
    const prompt = confirmPrompt(wait.when);
    this.awaitingConfirm = prompt !== undefined;
    if (prompt !== undefined) {
      this.emit({ type: "confirm-requested", at: startedAt, phase: phase.id, stage, prompt });
    }
    const named = await this.sourceFor(phaseValues(this.options.plan, phase));
    const every = phase.sample.every === "fastest" ? 0 : phase.sample.every * 1000;
    try {
      for (;;) {
        this.checkAbort();
        if (this.interrupt === "skip") return "skipped";
        await this.sample(phase.id, named);
        if (watching) await this.readFaultLists(phase.id);
        const at = this.clock.now();
        const status = tracker.status(at);
        this.emit({
          type: "progress",
          at,
          phase: phase.id,
          stage,
          progress: status.progress,
          elapsedMs: at - startedAt,
          timeoutMs,
        });
        if (status.met) {
          this.emit({ type: "condition-met", at, phase: phase.id, stage });
          return "met";
        }
        if (at - startedAt >= timeoutMs) {
          this.emit({
            type: "condition-timed-out",
            at,
            phase: phase.id,
            stage,
            onTimeout: wait.onTimeout,
          });
          return "timed-out";
        }
        await this.pause(Math.min(every, timeoutMs - (at - startedAt)));
      }
    } finally {
      this.tracker = undefined;
      this.awaitingConfirm = false;
    }
  }

  /** Sleeps on the clock, ending early when confirmed, skipped or aborted. Always yields, so a fastest phase still lets other work run. */
  private async pause(milliseconds: number): Promise<void> {
    const woken = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    await Promise.race([this.clock.sleep(Math.max(0, milliseconds)), woken]);
    this.wake = () => undefined;
  }

  private observe(observation: Observation): void {
    this.tracker?.observe(observation);
    this.untilTracker?.observe(observation);
  }

  private async sample(phase: string, named: NamedSource): Promise<void> {
    const values = await this.options.link.withSession(() => named.source.read(() => undefined));
    const at = this.clock.now();
    const readings: PlanReading[] = named.source.columns.map((column, position) => ({
      name: named.names[position] ?? column.label,
      label: column.label,
      unit: column.unit,
      value: values[position],
    }));
    const first = new Map<string, number | string | undefined>();
    for (const reading of readings) {
      if (!first.has(reading.name)) first.set(reading.name, reading.value);
      if (reading.value !== undefined) {
        this.pending.push({
          runId: this.runId,
          signal: reading.label,
          unit: reading.unit,
          timestamp: at,
          value: reading.value,
        });
      }
    }
    this.observe({ type: "sample", at, values: first });
    this.emit({ type: "sample", at, phase, readings });
    if (this.pending.length >= FLUSH_SIZE) await this.flush();
  }

  /** Reads every fault code list when one is due. */
  private async readFaultLists(phase: string): Promise<void> {
    const at = this.clock.now();
    if (this.lastCodesAt !== undefined && at - this.lastCodesAt < this.codesIntervalMs) return;
    for (const list of FAULT_LISTS) await this.readList(phase, list);
    this.lastCodesAt = this.clock.now();
  }

  /** Reads one code list, records a change and reports each code that appeared or cleared. */
  private async readList(phase: string, list: FaultList): Promise<Map<number, string[]>> {
    const answers = await this.options.link.withSession(({ elm }) => codes(elm, CODE_MODES[list]));
    const at = this.clock.now();
    const found = [...new Set([...answers.values()].flat())].sort();
    const before = this.lastCodes.get(list);
    this.lastCodes.set(list, found);
    if (before?.join(" ") !== found.join(" ")) {
      this.pending.push(faultListSample(this.runId, list, found, at));
    }
    if (before !== undefined) {
      for (const code of found.filter((code) => !before.includes(code))) {
        this.emit({ type: "code-appeared", at, phase, list, code });
      }
      for (const code of before.filter((code) => !found.includes(code))) {
        this.emit({ type: "code-cleared", at, phase, list, code });
      }
    }
    this.observe({ type: "codes", at, list, codes: found });
    return answers;
  }

  private async read(phase: PlanPhase, read: PlanRead, when: WaitStage): Promise<ReadRecord> {
    this.checkAbort();
    let result: ReadResult;
    try {
      result = await this.readOnce(phase.id, read);
    } catch (error) {
      // A unit that refuses or garbles one read does not end the plan; the record says why.
      if (!isCommandError(error)) throw error;
      result = { kind: "failed", error: error.message };
    }
    const record: ReadRecord = { read, when, at: this.clock.now(), result };
    this.emit({ type: "read", at: record.at, phase: phase.id, record });
    return record;
  }

  private async readOnce(phase: string, read: PlanRead): Promise<ReadResult> {
    const list = READ_LISTS[read];
    if (list !== undefined) {
      const answers = await this.readList(phase, list);
      return {
        kind: "codes",
        list,
        units: [...answers].map(([sender, found]) => ({ unit: unitKey(sender), codes: found })),
      };
    }
    if (read === "freeze-frame") {
      const frames = await this.options.link.withSession(({ elm }) => freezeFrame(elm));
      return {
        kind: "freeze-frame",
        units: [...frames].map(([sender, frame]) => ({
          unit: unitKey(sender),
          code: frame.code,
          values: Object.fromEntries(frame.values),
        })),
      };
    }
    const counts = await this.options.link.withSession(({ elm }) => misfireCounts(elm));
    return {
      kind: "misfire-counters",
      units: [...counts].map(([sender, monitors]) => ({
        unit: unitKey(sender),
        monitors: monitors.map((monitor) => ({
          monitor: monitor.monitor,
          averageLastTenCycles: monitor.averageLastTenCycles ?? null,
          lastCycle: monitor.lastCycle ?? null,
        })),
      })),
    };
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    await this.options.storage.appendSamples(this.pending.splice(0));
  }
}

/** The condition a wait waits for, in words: the same text the runner's `waiting` event carries. */
export function describeWait(wait: PlanWait): string {
  return `${describeCondition(wait.when)} (at most ${String(wait.timeout)} s, then ${wait.onTimeout})`;
}
