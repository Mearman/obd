/**
 * Recording plans run in the background on the open connection, as captures do: one at a time, with a status a caller polls, a stream of the runner's events, and confirm, skip and abort.
 *
 * The service starts a plan and returns once its run exists, so the caller has the run's id at once. The runner reads the car through the link's sessions, one read at a time, so a plan and nothing else holds the adapter while it runs; the service refuses other work on the adapter meanwhile. A job is kept after it ends, so a page that subscribes late still sees how it went. This module is platform-free.
 */

import { z } from "zod";
import { FAULT_LISTS } from "./fault-history.js";
import { ON_TIMEOUT, planPhaseSchema, planSchema, type Plan } from "./plan.js";
import {
  PlanRunner,
  phaseRecordSchema,
  readRecordSchema,
  type PlanClock,
  type PlanEvent,
  type PlanLink,
} from "./plan-runner.js";
import type { Storage } from "./storage.js";

const nameSchema = z.string().min(1);
const at = z.number();
const stage = z.enum(["start", "end"]);

/** One reading of a `sample` event. */
const planReadingSchema = z.object({
  name: nameSchema,
  label: z.string(),
  unit: z.string(),
  /** Absent where the value was not read this time. */
  value: z.union([z.number(), z.string()]).optional(),
});

/** A {@link PlanEvent} as it crosses the service boundary. */
export const planEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan-started"), at, runId: nameSchema, plan: planSchema }),
  z.object({
    type: z.literal("phase-started"),
    at,
    phase: planPhaseSchema,
    index: z.number().int().nonnegative(),
    iteration: z.number().int().positive(),
    iterations: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("waiting"),
    at,
    phase: nameSchema,
    stage,
    condition: z.string(),
    timeoutMs: z.number(),
  }),
  z.object({
    type: z.literal("sample"),
    at,
    phase: nameSchema,
    readings: z.array(planReadingSchema).readonly(),
  }),
  z.object({
    type: z.literal("progress"),
    at,
    phase: nameSchema,
    stage,
    progress: z.string(),
    elapsedMs: z.number(),
    timeoutMs: z.number(),
  }),
  z.object({ type: z.literal("condition-met"), at, phase: nameSchema, stage }),
  z.object({
    type: z.literal("condition-timed-out"),
    at,
    phase: nameSchema,
    stage,
    onTimeout: z.enum(ON_TIMEOUT),
  }),
  z.object({
    type: z.literal("confirm-requested"),
    at,
    phase: nameSchema,
    stage,
    prompt: z.string(),
  }),
  z.object({
    type: z.enum(["code-appeared", "code-cleared"]),
    at,
    phase: nameSchema,
    list: z.enum(FAULT_LISTS),
    code: nameSchema,
  }),
  z.object({ type: z.literal("read"), at, phase: nameSchema, record: readRecordSchema }),
  z.object({ type: z.literal("phase-finished"), at, record: phaseRecordSchema }),
  z.object({
    type: z.literal("finished"),
    at,
    runId: nameSchema,
    outcome: z.enum(["completed", "failed", "aborted"]),
    reason: z.string().optional(),
  }),
]);

/** A plan event as a caller receives it. */
export type PlanEventData = z.output<typeof planEventSchema>;

// Every event the runner emits passes the schema the contract checks it against.
type Assignable<T extends U, U> = T;
export type PlanEventFitsSchema = Assignable<PlanEvent, PlanEventData>;

/** How a plan started here is going. */
export const planStatusSchema = z.object({
  runId: nameSchema,
  plan: z.object({ name: nameSchema, title: z.string() }),
  /** `running` until the plan ends, then how it ended. */
  state: z.enum(["running", "completed", "failed", "aborted"]),
  /** The index of the phase running or last run; `null` before the first starts. */
  phase: z.number().int().nonnegative().nullable(),
  /** Whether the current wait asks the person to confirm. */
  awaitingConfirm: z.boolean(),
  /** Why the plan failed or was aborted, else `null`. */
  reason: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});

/** How a plan is going. */
export type PlanStatus = z.output<typeof planStatusSchema>;

/** A plan is already running; only one runs at a time. */
export class PlanBusy extends Error {
  override name = "PlanBusy";
}

/** A plan event subscriber stopped reading and fell more than {@link PLAN_EVENT_BUFFER} events behind. */
export class PlanSubscriberOverflow extends Error {
  override name = "PlanSubscriberOverflow";
}

/** The most events a subscriber may have waiting before it is ended as too slow. */
export const PLAN_EVENT_BUFFER = 10_000;

/** What {@link PlanJobs} needs. */
export interface PlanJobsDependencies {
  readonly link: PlanLink;
  readonly storage: Storage;
  readonly clock: PlanClock;
  /** The gap between reads of the fault code lists while a phase watches them; omitted, the runner's default. */
  readonly codesIntervalMs?: number;
}

/** Where and how a plan runs, from the open connection. */
export interface PlanStart {
  readonly adapter: string;
  readonly profile?: string;
  readonly idBits: 11 | 29;
  readonly bitrate: number;
  readonly notes: string;
  /** The VIN the connection has read, stored on the run; `null` when it has read none. */
  readonly vin: string | null;
}

/** The part of an `AbortSignal` an event stream uses; core has no DOM types, and a real `AbortSignal` satisfies it. */
interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { readonly once: boolean }): void;
}

interface Job {
  status: PlanStatus;
  readonly runner: PlanRunner;
  /** Every event but samples and progress, which are frequent and kept only as the latest of the phase. */
  readonly history: PlanEvent[];
  latestSample: PlanEvent | undefined;
  latestProgress: PlanEvent | undefined;
  readonly listeners: Set<(event: PlanEvent) => void>;
}

/** The status change an event makes. */
function statusAfter(status: PlanStatus, event: PlanEvent): PlanStatus {
  switch (event.type) {
    case "phase-started":
      return { ...status, phase: event.index, awaitingConfirm: false };
    case "confirm-requested":
      return { ...status, awaitingConfirm: true };
    case "condition-met":
    case "condition-timed-out":
    case "phase-finished":
      return { ...status, awaitingConfirm: false };
    case "finished":
      return {
        ...status,
        state: event.outcome,
        awaitingConfirm: false,
        reason: event.reason ?? null,
        endedAt: event.at,
      };
    default:
      return status;
  }
}

/** The background plans of one service. */
export class PlanJobs {
  private readonly jobs = new Map<string, Job>();
  private starting = false;
  private running: string | undefined;

  constructor(private readonly dependencies: PlanJobsDependencies) {}

  /** Whether a plan is starting or running. */
  get busy(): boolean {
    return this.starting || this.running !== undefined;
  }

  /** Whether `runId` is the run of a plan running here. */
  isRunning(runId: string): boolean {
    return this.running === runId;
  }

  /**
   * Starts `plan` and resolves with its first status once its run exists.
   *
   * @throws PlanBusy when a plan is running.
   * @throws What {@link PlanRunner.run} throws before its run exists: an `OptionError` for a value the car does not report, an adapter error. No run is stored then.
   */
  start(plan: Plan, start: PlanStart): Promise<PlanStatus> {
    if (this.busy) {
      throw new PlanBusy("a recording plan is running; abort it or wait for it to end");
    }
    this.starting = true;
    const { link, storage, clock, codesIntervalMs } = this.dependencies;
    return new Promise<PlanStatus>((resolve, reject) => {
      let job: Job | undefined;
      const runner = new PlanRunner({
        plan,
        link,
        storage,
        clock,
        adapter: start.adapter,
        ...(start.profile === undefined ? {} : { profile: start.profile }),
        idBits: start.idBits,
        bitrate: start.bitrate,
        notes: start.notes,
        ...(start.vin === null ? {} : { vin: start.vin }),
        ...(codesIntervalMs === undefined ? {} : { codesIntervalMs }),
        onEvent: (event) => {
          if (event.type === "plan-started") {
            job = {
              status: {
                runId: event.runId,
                plan: { name: plan.name, title: plan.title },
                state: "running",
                phase: null,
                awaitingConfirm: false,
                reason: null,
                startedAt: event.at,
                endedAt: null,
              },
              runner,
              history: [],
              latestSample: undefined,
              latestProgress: undefined,
              listeners: new Set(),
            };
            this.jobs.set(event.runId, job);
            this.running = event.runId;
            this.starting = false;
            this.record(job, event);
            resolve({ ...job.status });
            return;
          }
          if (job !== undefined) this.record(job, event);
        },
      });
      runner
        .run()
        .catch((error: unknown) => {
          if (job === undefined) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          // The runner stores and stops the run before it rethrows, but sends no `finished`; one is sent here so every stream ends.
          if (job.status.state === "running") {
            this.record(job, {
              type: "finished",
              at: clock.now(),
              runId: job.status.runId,
              outcome: "failed",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          this.starting = false;
          if (job !== undefined && this.running === job.status.runId) this.running = undefined;
        });
    });
  }

  /** A plan's status, or `undefined` for a run no plan started here. */
  status(runId: string): PlanStatus | undefined {
    const job = this.jobs.get(runId);
    return job === undefined ? undefined : { ...job.status };
  }

  /** Answers the confirmation the plan's current wait asks for; returns its status, or `undefined` for an unknown run. */
  confirm(runId: string): PlanStatus | undefined {
    return this.command(runId, (runner) => {
      runner.confirm();
    });
  }

  /** Ends the plan's current phase as skipped; returns its status, or `undefined` for an unknown run. */
  skipPhase(runId: string): PlanStatus | undefined {
    return this.command(runId, (runner) => {
      runner.skipPhase();
    });
  }

  /** Ends the plan at its next step, keeping its run; returns its status, or `undefined` for an unknown run. */
  abort(runId: string): PlanStatus | undefined {
    return this.command(runId, (runner) => {
      runner.abort();
    });
  }

  /**
   * Yields the plan's events so far, then each new one, ending after `finished` or when `signal` aborts. Of the frequent `sample` and `progress` events only the latest of the phase is replayed.
   *
   * @throws PlanSubscriberOverflow when the consumer falls more than {@link PLAN_EVENT_BUFFER} events behind.
   */
  async *events(runId: string, signal: AbortLike | undefined): AsyncGenerator<PlanEvent> {
    const job = this.jobs.get(runId);
    if (job === undefined) return;
    const queue: PlanEvent[] = [
      ...job.history,
      ...[job.latestSample, job.latestProgress].filter((event) => event !== undefined),
    ];
    const pending: { wake: (() => void) | undefined; overflowed: boolean } = {
      wake: undefined,
      overflowed: false,
    };
    const listener = (event: PlanEvent): void => {
      if (queue.length >= PLAN_EVENT_BUFFER) pending.overflowed = true;
      else queue.push(event);
      pending.wake?.();
    };
    const finished = job.status.state !== "running";
    if (!finished) job.listeners.add(listener);
    const onAbort = (): void => {
      pending.wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (signal?.aborted !== true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          if (next.type === "finished") return;
        } else if (pending.overflowed) {
          throw new PlanSubscriberOverflow(
            `plan events fell more than ${String(PLAN_EVENT_BUFFER)} behind`,
          );
        } else if (finished) {
          return;
        } else {
          await new Promise<void>((resolve) => {
            pending.wake = resolve;
          });
          pending.wake = undefined;
        }
      }
    } finally {
      job.listeners.delete(listener);
    }
  }

  private command(runId: string, act: (runner: PlanRunner) => void): PlanStatus | undefined {
    const job = this.jobs.get(runId);
    if (job === undefined) return undefined;
    if (job.status.state === "running") act(job.runner);
    return { ...job.status };
  }

  private record(job: Job, event: PlanEvent): void {
    job.status = statusAfter(job.status, event);
    if (event.type === "sample") job.latestSample = event;
    else if (event.type === "progress") job.latestProgress = event;
    else {
      if (event.type === "phase-started") {
        job.latestSample = undefined;
        job.latestProgress = undefined;
      }
      job.history.push(event);
    }
    for (const listener of job.listeners) listener(event);
  }
}
