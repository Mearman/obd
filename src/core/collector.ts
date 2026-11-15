/**
 * The collection loop: polls the values a run selected, stores them in batches, rides out a dropped link and stops on request.
 *
 * {@link LiveCollector} implements the service's {@link Collector} over a {@link DeviceLink}. A run reads either the named values of one unit in the profile or the legislated values the car supports; each reading becomes a sample whose signal is the value's label. When the link drops (a transport or adapter error) the collector reconnects with exponential backoff and carries on; any other error ends collection with the state `failed`, leaving the run open so the user decides. This module is platform-free.
 */

import { ElmError } from "./elm.js";
import { buildSource, type Source } from "./live.js";
import { GENERIC_PROFILE, profileLabel, sessionBus } from "./generic.js";
import type { DeviceLink, LinkSession } from "./device-link.js";
import { now as clockNow, sleep as realSleep } from "./time.js";
import { TransportError } from "./transport.js";
import { StorageError, type Run, type Sample } from "./storage.js";
import type { z } from "zod";
import type { collectionRequestSchema } from "./service.js";

/** What a run collects. A run with no profile collects the legislated values only. */
export type CollectionRequest = z.output<typeof collectionRequestSchema>;

/** Where a {@link Collector} sends the samples it reads. */
export interface SampleSink {
  /**
   * Stores the samples and hands them to live subscribers. Resolves once they are stored.
   *
   * @throws StorageError when a sample names an unknown or stopped run.
   */
  write(samples: readonly Sample[]): Promise<void>;
}

/** Where a run's collection is. */
export const COLLECTION_STATES = ["collecting", "reconnecting", "failed"] as const;

/** Where a run's collection is. */
export type CollectionState = (typeof COLLECTION_STATES)[number];

/** How a run's collection is going. */
export interface CollectionStatus {
  readonly state: CollectionState;
  /** Reconnection attempts since the link last worked; zero while collecting. */
  readonly attempt: number;
  /** The last error's message, or `null` when there has been none. */
  readonly lastError: string | null;
  /** Samples handed to the sink since collection started in this process. */
  readonly samples: number;
}

/** Polls an adapter for a run. */
export interface Collector {
  /**
   * Begins collecting for `run` and returns once collection is under way; samples then arrive on `sink` until {@link Collector.stop}.
   *
   * @throws Error when collection cannot start (unknown profile, value or adapter, a connection held for another adapter); the service removes the run it opened.
   */
  start(run: Run, request: CollectionRequest, sink: SampleSink): Promise<void>;

  /** Stops collecting for the run and stores what is buffered. Does nothing for a run this collector is not collecting. */
  stop(runId: string): Promise<void>;

  /** The runs being collected, including those reconnecting or failed. */
  active(): readonly string[];

  /** How a run's collection is going, or `undefined` for a run this collector is not collecting. */
  status(runId: string): CollectionStatus | undefined;
}

/** The first reconnection delay, in milliseconds. */
export const RECONNECT_BASE_MS = 500;

/** The longest reconnection delay, in milliseconds. */
export const RECONNECT_MAX_MS = 30_000;

/** The delay before reconnection attempt `attempt` (counted from 1): doubles each time up to {@link RECONNECT_MAX_MS}. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

/** How a {@link LiveCollector} paces itself; every field has a default. */
export interface CollectorTiming {
  /** The gap between polls of the selected values, in milliseconds. */
  readonly pollMs?: number;
  /** The longest the collector holds readings before storing them, in milliseconds. */
  readonly flushMs?: number;
  /** The most readings it holds before storing them. */
  readonly batchSize?: number;
  /** The delay before each reconnection attempt. */
  readonly reconnectDelay?: (attempt: number) => number;
}

/** What {@link LiveCollector} needs. */
export interface LiveCollectorDependencies extends CollectorTiming {
  readonly link: DeviceLink;
  /** The clock for sample times; defaults to the system clock. */
  readonly now?: () => number;
  /** Waits; defaults to a timer. Tests pass one they control. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_BATCH_SIZE = 100;

/** A failure of the link rather than of the request: worth reconnecting for. */
function isLinkDrop(error: unknown): boolean {
  return error instanceof TransportError || error instanceof ElmError;
}

interface Job {
  readonly run: Run;
  readonly request: CollectionRequest;
  readonly sink: SampleSink;
  readonly ownsLink: boolean;
  stopping: boolean;
  wake: (() => void) | undefined;
  loop: Promise<void>;
  status: CollectionStatus;
  pending: Sample[];
  lastFlush: number;
}

/** A {@link Collector} that reads a {@link DeviceLink}. */
export class LiveCollector implements Collector {
  private readonly jobs = new Map<string, Job>();
  private readonly pollMs: number;
  private readonly flushMs: number;
  private readonly batchSize: number;
  private readonly delayFor: (attempt: number) => number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: LiveCollectorDependencies) {
    this.pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
    this.flushMs = dependencies.flushMs ?? DEFAULT_FLUSH_MS;
    this.batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE;
    this.delayFor = dependencies.reconnectDelay ?? reconnectDelay;
    this.now = dependencies.now ?? clockNow;
    this.sleep = dependencies.sleep ?? realSleep;
  }

  async start(run: Run, request: CollectionRequest, sink: SampleSink): Promise<void> {
    const collecting = this.jobs.keys().next();
    if (collecting.done !== true) {
      throw new StorageError(
        "conflict",
        `run ${collecting.value} is collecting; one run holds the adapter at a time`,
      );
    }
    const { link } = this.dependencies;
    const connected = link.session;
    const ownsLink = connected === undefined;
    const session =
      connected ??
      (await link.connect(run.profile === GENERIC_PROFILE ? undefined : run.profile, run.adapter));
    try {
      if (session.adapterUrl !== run.adapter || profileLabel(session.profile) !== run.profile) {
        throw new StorageError(
          "conflict",
          `the connection is to ${session.adapterUrl} with ${profileLabel(session.profile)}, not what run ${run.id} collects from`,
        );
      }
      const source = await this.sourceFor(request);
      const job: Job = {
        run,
        request,
        sink,
        ownsLink,
        stopping: false,
        wake: undefined,
        loop: Promise.resolve(),
        status: { state: "collecting", attempt: 0, lastError: null, samples: 0 },
        pending: [],
        lastFlush: this.now(),
      };
      this.jobs.set(run.id, job);
      job.loop = this.poll(job, source);
    } catch (error) {
      if (ownsLink) await link.disconnect();
      throw error;
    }
  }

  async stop(runId: string): Promise<void> {
    const job = this.jobs.get(runId);
    if (job === undefined) return;
    job.stopping = true;
    job.wake?.();
    await job.loop;
    this.jobs.delete(runId);
    if (job.ownsLink) await this.dependencies.link.disconnect();
  }

  active(): readonly string[] {
    return [...this.jobs.keys()];
  }

  status(runId: string): CollectionStatus | undefined {
    return this.jobs.get(runId)?.status;
  }

  private sourceFor(request: CollectionRequest): Promise<Source> {
    return this.dependencies.link.withSession((session) => this.buildSource(session, request));
  }

  private buildSource(session: LinkSession, request: CollectionRequest): Promise<Source> {
    const bus = sessionBus(session.profile);
    return buildSource(
      session.elm,
      session.profile,
      {
        ...(request.unit === undefined ? {} : { unit: request.unit }),
        values: request.signals ?? [],
        idBits: bus.idBits,
        bitrate: bus.bitrate,
      },
      () => undefined,
    );
  }

  /** Waits `milliseconds` or until the job is told to stop. */
  private async idle(job: Job, milliseconds: number): Promise<void> {
    if (job.stopping) return;
    const woken = new Promise<void>((resolve) => {
      job.wake = resolve;
    });
    await Promise.race([this.sleep(milliseconds), woken]);
    job.wake = undefined;
  }

  private async flush(job: Job): Promise<void> {
    job.lastFlush = this.now();
    if (job.pending.length === 0) return;
    const batch = job.pending;
    job.pending = [];
    await job.sink.write(batch);
  }

  private async poll(job: Job, first: Source): Promise<void> {
    let source = first;
    try {
      while (!job.stopping) {
        try {
          const readings = await this.dependencies.link.withSession(() =>
            source.read(() => undefined),
          );
          const timestamp = this.now();
          source.columns.forEach((column, index) => {
            const value = readings[index];
            if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
              return;
            }
            job.pending.push({
              runId: job.run.id,
              signal: column.label,
              unit: column.unit,
              timestamp,
              value,
            });
          });
          job.status = { ...job.status, state: "collecting", attempt: 0 };
          if (job.pending.length >= this.batchSize || timestamp - job.lastFlush >= this.flushMs) {
            const count = job.pending.length;
            await this.flush(job);
            job.status = { ...job.status, samples: job.status.samples + count };
          }
          await this.idle(job, this.pollMs);
        } catch (error) {
          if (isStopping(job)) break;
          if (!isLinkDrop(error)) throw error;
          const recovered = await this.recover(job, error);
          if (recovered === undefined) break;
          source = recovered;
        }
      }
    } catch (error) {
      job.status = { ...job.status, state: "failed", lastError: describe(error) };
    } finally {
      const count = job.pending.length;
      try {
        await this.flush(job);
        job.status = { ...job.status, samples: job.status.samples + count };
      } catch (error) {
        job.status = { ...job.status, state: "failed", lastError: describe(error) };
      }
    }
  }

  /** Stores what is buffered, then reconnects with backoff until it works; `undefined` when the job was stopped first. */
  private async recover(job: Job, dropped: unknown): Promise<Source | undefined> {
    const count = job.pending.length;
    await this.flush(job);
    job.status = {
      ...job.status,
      samples: job.status.samples + count,
      lastError: describe(dropped),
    };
    for (let attempt = 1; !job.stopping; attempt++) {
      job.status = { ...job.status, state: "reconnecting", attempt };
      await this.idle(job, this.delayFor(attempt));
      if (isStopping(job)) break;
      try {
        await this.dependencies.link.reconnect();
        const source = await this.sourceFor(job.request);
        job.status = { ...job.status, state: "collecting", attempt: 0 };
        return source;
      } catch (error) {
        if (!isLinkDrop(error)) throw error;
        job.status = { ...job.status, lastError: describe(error) };
      }
    }
    return undefined;
  }
}

/** Whether the job has been told to stop; a function so the narrowing of `job.stopping` does not outlive an await. */
function isStopping(job: Job): boolean {
  return job.stopping;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
