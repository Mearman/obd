/**
 * Captures run in the background on the open connection: one at a time, with a status a caller polls or streams, a stop, and the finished capture saved to storage.
 *
 * A capture can take minutes (an identifier sweep pauses between requests), so the service starts it and returns at once, as the collector does for a run. The job holds the connection (`DeviceLink.withSession`) for its whole length, so nothing else is sent to the adapter meanwhile. This module is platform-free.
 */

import { z } from "zod";
import { captureId } from "./capture.js";
import {
  captureEverything,
  discoveryRangeSchema,
  identifierSweepSchema,
  type CaptureStep,
  type DiscoveryRange,
  type IdentifierSweep,
} from "./capture-run.js";
import type { DeviceLink } from "./device-link.js";
import { captureSummarySchema, type CaptureSummary, type Storage } from "./storage.js";

/** What a caller gives to start a capture on the open connection. */
export const startCaptureInputSchema = z.object({
  /** The discovery sweep, for a connection with no profile; ignored with one. */
  discovery: discoveryRangeSchema.optional(),
  /** The identifier sweep; omitted, none runs. */
  identifiers: identifierSweepSchema.optional(),
});

/** What a caller gives to start a capture. */
export type StartCaptureInput = z.output<typeof startCaptureInputSchema>;

/** The steps a capture goes through, as its status names them. */
export const CAPTURE_STEPS = [
  "legislated",
  "units",
  "discovery",
  "identifiers",
] as const satisfies readonly CaptureStep[];

/** How a capture is going. */
export const captureStatusSchema = z.object({
  id: z.string().min(1),
  /** `capturing` until it ends; `saved` once stored, stopped or not; `failed` when it could not finish or be stored. */
  state: z.enum(["capturing", "saved", "failed"]),
  step: z.enum(CAPTURE_STEPS).nullable(),
  /** Requests recorded so far. */
  exchanges: z.number().int().nonnegative(),
  detail: z.string(),
  /** Whether a stop was asked for. */
  stopping: z.boolean(),
  error: z.string().nullable(),
  /** The stored capture, once saved. */
  summary: captureSummarySchema.nullable(),
});

/** How a capture is going. */
export type CaptureStatus = z.output<typeof captureStatusSchema>;

/** A capture is already running; only one runs at a time. */
export class CaptureBusy extends Error {
  override name = "CaptureBusy";
}

/** What {@link CaptureJobs} needs. */
export interface CaptureJobsDependencies {
  readonly link: DeviceLink;
  readonly storage: Storage;
  /** The program's version, as captures record it. */
  readonly toolVersion: string;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** A short random suffix for a capture id. */
  readonly suffix: () => string;
}

/** The part of an `AbortSignal` a progress stream uses; core has no DOM types, and a real `AbortSignal` satisfies it. */
interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { readonly once: boolean }): void;
}

interface Job {
  status: CaptureStatus;
  stop: boolean;
  readonly listeners: Set<() => void>;
}

/** The background captures of one service. */
export class CaptureJobs {
  private readonly jobs = new Map<string, Job>();
  private running: string | undefined;

  constructor(private readonly dependencies: CaptureJobsDependencies) {}

  /** Whether a capture is running. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /**
   * Starts a capture on the open connection and returns its first status.
   *
   * @throws CaptureBusy when a capture is running.
   * @throws NotConnected (from the link) when the job's turn comes and there is no connection; the status then says `failed`.
   */
  start(input: StartCaptureInput): CaptureStatus {
    if (this.running !== undefined) {
      throw new CaptureBusy(`capture ${this.running} is running; stop it or wait for it to end`);
    }
    const { now, link, storage, toolVersion, sleep } = this.dependencies;
    const id = captureId(now(), this.dependencies.suffix());
    const job: Job = {
      status: {
        id,
        state: "capturing",
        step: null,
        exchanges: 0,
        detail: "waiting for the adapter",
        stopping: false,
        error: null,
        summary: null,
      },
      stop: false,
      listeners: new Set(),
    };
    this.jobs.set(id, job);
    this.running = id;
    const discovery: DiscoveryRange | undefined = input.discovery;
    const identifiers: IdentifierSweep | undefined = input.identifiers;
    void link
      .withSession(async (session) => {
        const capture = await captureEverything(session.elm, {
          profile: session.profile,
          ...(discovery === undefined ? {} : { discovery }),
          ...(identifiers === undefined ? {} : { identifiers }),
          adapter: session.adapter,
          adapterUrl: session.adapterUrl,
          toolVersion,
          id,
          now,
          sleep,
          stopped: () => job.stop,
          progress: (progress) => {
            this.update(job, {
              step: progress.step,
              exchanges: progress.exchanges,
              detail: progress.detail,
            });
          },
        });
        return storage.saveCapture(capture);
      })
      .then(
        (summary: CaptureSummary) => {
          this.update(job, {
            state: "saved",
            exchanges: summary.exchanges,
            detail: summary.complete ? "saved" : "stopped and saved",
            summary,
          });
        },
        (error: unknown) => {
          this.update(job, {
            state: "failed",
            detail: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (this.running === id) this.running = undefined;
      });
    return { ...job.status };
  }

  /** Asks a running capture to stop after the request in flight; returns its status, or `undefined` for an unknown id. */
  stop(id: string): CaptureStatus | undefined {
    const job = this.jobs.get(id);
    if (job === undefined) return undefined;
    if (job.status.state === "capturing") {
      job.stop = true;
      this.update(job, { stopping: true });
    }
    return { ...job.status };
  }

  /** A capture's status, or `undefined` for an id this service did not start. */
  status(id: string): CaptureStatus | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : { ...job.status };
  }

  /**
   * Yields the capture's status now and at every change until it ends or `signal` aborts. Changes between two reads are merged into the latest status.
   */
  async *progress(id: string, signal: AbortLike | undefined): AsyncGenerator<CaptureStatus> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    // One object, so the loop sees what the listener sets between its reads.
    const pending: { changed: boolean; wake: (() => void) | undefined } = {
      changed: true,
      wake: undefined,
    };
    const listener = (): void => {
      pending.changed = true;
      pending.wake?.();
    };
    job.listeners.add(listener);
    signal?.addEventListener("abort", listener, { once: true });
    try {
      while (signal?.aborted !== true) {
        if (pending.changed) {
          pending.changed = false;
          const status = { ...job.status };
          yield status;
          if (status.state !== "capturing") return;
          continue;
        }
        await new Promise<void>((resolve) => {
          pending.wake = resolve;
        });
        pending.wake = undefined;
      }
    } finally {
      job.listeners.delete(listener);
    }
  }

  private update(job: Job, change: Partial<CaptureStatus>): void {
    job.status = { ...job.status, ...change };
    for (const listener of job.listeners) listener();
  }
}
