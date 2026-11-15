/**
 * The in-process implementation of {@link diagnosticsContract} over {@link Storage}.
 *
 * This is the service an edge hosts: the UI's own process calls {@link DiagnosticsHost.client} directly, a dedicated worker serves {@link DiagnosticsHost.router} over a message port, and a Node daemon serves it over a socket. What actually polls an adapter is a {@link Collector} the host injects, so this module holds the run lifecycle, storage and live fan-out and nothing platform-specific.
 */

import { ORPCError, createRouterClient, implement, type RouterClient } from "@orpc/server";
import {
  diagnosticsContract,
  type AdapterCapability,
  type DiagnosticsContract,
} from "./service.js";
import { exportRunCsvText, exportRunJson } from "./run-export.js";
import { ProfileError, parseJson, parseProfile } from "./profile.js";
import { checkProfile } from "./profile-check.js";
import { StorageError, jsonSchema, type Run, type Sample, type Storage } from "./storage.js";
import { SCHEMES, registeredSchemes, type Scheme } from "./transport.js";

/** Where a {@link Collector} sends the samples it reads. */
export interface SampleSink {
  /**
   * Stores the samples and hands them to live subscribers. Resolves once they are stored.
   *
   * @throws StorageError when a sample names an unknown or stopped run.
   */
  write(samples: readonly Sample[]): Promise<void>;
}

/**
 * Polls an adapter for a run. The implementation of this is the live-data layer: it opens the adapter named by the run, reads the signals on the profile's schedule and writes what it reads to the sink.
 */
export interface Collector {
  /**
   * Begins collecting for `run` and returns once collection is under way; samples then arrive on `sink` until {@link Collector.stop}.
   *
   * @param signals The profile values to poll, or `undefined` for every value the profile names.
   * @throws Error when collection cannot start (unknown profile, adapter unreachable); the service removes the run it opened.
   */
  start(run: Run, signals: readonly string[] | undefined, sink: SampleSink): Promise<void>;

  /** Stops collecting for the run. Does nothing for a run this collector is not collecting. */
  stop(runId: string): Promise<void>;
}

/** What {@link createDiagnosticsHost} needs from its edge. */
export interface DiagnosticsDependencies {
  readonly storage: Storage;
  readonly collector: Collector;
  /** The clock for run start and stop times; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The most samples a live subscriber may have waiting before it is ended as too slow. */
export const LIVE_SUBSCRIBER_BUFFER = 10_000;

/** A live subscriber stopped reading and fell more than {@link LIVE_SUBSCRIBER_BUFFER} samples behind. */
export class LiveSubscriberOverflow extends Error {
  override name = "LiveSubscriberOverflow";
}

interface Subscriber {
  readonly runId: string | undefined;
  readonly queue: Sample[];
  wake: (() => void) | undefined;
  overflowed: boolean;
}

/** The part of an `AbortSignal` the live fan-out uses; core has no DOM types, and a real `AbortSignal` satisfies it. */
interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { readonly once: boolean }): void;
}

/** Fans collected samples out to the subscribers of `live.samples`. */
class LiveHub {
  private readonly subscribers = new Set<Subscriber>();

  publish(samples: readonly Sample[]): void {
    for (const subscriber of this.subscribers) {
      for (const sample of samples) {
        if (subscriber.runId !== undefined && sample.runId !== subscriber.runId) continue;
        if (subscriber.queue.length >= LIVE_SUBSCRIBER_BUFFER) {
          subscriber.overflowed = true;
          break;
        }
        subscriber.queue.push(sample);
      }
      subscriber.wake?.();
    }
  }

  /** Yields samples as they are published until `signal` aborts or the consumer stops iterating. */
  async *subscribe(
    runId: string | undefined,
    signal: AbortLike | undefined,
  ): AsyncGenerator<Sample> {
    const subscriber: Subscriber = { runId, queue: [], wake: undefined, overflowed: false };
    this.subscribers.add(subscriber);
    const onAbort = (): void => {
      subscriber.wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (signal?.aborted !== true) {
        const next = subscriber.queue.shift();
        if (next !== undefined) {
          yield next;
        } else if (subscriber.overflowed) {
          throw new LiveSubscriberOverflow(
            `live samples fell more than ${String(LIVE_SUBSCRIBER_BUFFER)} behind`,
          );
        } else {
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
          subscriber.wake = undefined;
        }
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}

const SCHEME_FACTS: Readonly<
  Record<Scheme, Pick<AdapterCapability, "platform" | "userPicksDevice" | "description">>
> = {
  ble: {
    platform: "node",
    userPicksDevice: false,
    description: "Bluetooth LE adapter by name or address",
  },
  serial: {
    platform: "node",
    userPicksDevice: false,
    description: "USB or Bluetooth serial adapter by device path",
  },
  tcp: { platform: "node", userPicksDevice: false, description: "Wi-Fi adapter by host and port" },
  socketcan: { platform: "node", userPicksDevice: false, description: "SocketCAN interface" },
  slcan: {
    platform: "node",
    userPicksDevice: false,
    description: "SLCAN adapter on a serial device",
  },
  webserial: {
    platform: "browser",
    userPicksDevice: true,
    description: "USB or Bluetooth serial adapter chosen in the browser",
  },
  webbluetooth: {
    platform: "browser",
    userPicksDevice: true,
    description: "Bluetooth LE adapter chosen in the browser",
  },
  webusb: {
    platform: "browser",
    userPicksDevice: true,
    description: "WebUSB adapter chosen in the browser",
  },
};

/** Every adapter scheme with whether a transport is registered for it in this runtime. */
export function listAdapterCapabilities(): AdapterCapability[] {
  const registered = new Set(registeredSchemes());
  return SCHEMES.map((scheme) => ({
    scheme,
    ...SCHEME_FACTS[scheme],
    available: registered.has(scheme),
  }));
}

const STORAGE_ERROR_CODES = {
  "not-found": "NOT_FOUND",
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
} as const;

/** Runs `work`, turning the errors a caller can act on into oRPC errors with the matching code. */
async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ORPCError(STORAGE_ERROR_CODES[error.code], { message: error.message });
    }
    if (error instanceof ProfileError) {
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    throw error;
  }
}

/** The implemented service, ready to be called in process or served over a link. */
export interface DiagnosticsHost {
  /** The router to serve with an oRPC handler (message port, WebSocket, ...). */
  readonly router: ReturnType<typeof buildRouter>;
  /** A client that calls the router directly, in this process. */
  readonly client: RouterClient<ReturnType<typeof buildRouter>>;
}

/** The type of the client {@link DiagnosticsHost.client} and the worker link produce. */
export type DiagnosticsClient = RouterClient<ReturnType<typeof buildRouter>>;

function buildRouter(dependencies: DiagnosticsDependencies) {
  const { storage, collector } = dependencies;
  const now = dependencies.now ?? Date.now;
  const hub = new LiveHub();
  const sink: SampleSink = {
    write: async (samples) => {
      await storage.appendSamples(samples);
      hub.publish(samples);
    },
  };
  const os = implement(diagnosticsContract);
  return os.router({
    adapters: {
      list: os.adapters.list.handler(() => listAdapterCapabilities()),
    },
    runs: {
      start: os.runs.start.handler(({ input }) =>
        translated(async () => {
          const run = await storage.createRun({
            profile: input.profile,
            adapter: input.adapter,
            startedAt: now(),
            notes: input.notes,
          });
          try {
            await collector.start(run, input.signals, sink);
          } catch (error) {
            await storage.deleteRun(run.id);
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
              message: `could not start collecting: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            });
          }
          return run;
        }),
      ),
      stop: os.runs.stop.handler(({ input }) =>
        translated(async () => {
          await collector.stop(input.runId);
          return storage.stopRun(input.runId, now());
        }),
      ),
      list: os.runs.list.handler(({ input }) => translated(() => storage.listRuns(input))),
      get: os.runs.get.handler(({ input }) =>
        translated(async () => {
          const run = await storage.getRun(input.runId);
          if (run === undefined) throw new StorageError("not-found", `no run ${input.runId}`);
          return run;
        }),
      ),
      samples: os.runs.samples.handler(({ input }) => translated(() => storage.readSamples(input))),
      aggregate: os.runs.aggregate.handler(({ input }) =>
        translated(() => storage.aggregate(input)),
      ),
      export: os.runs.export.handler(({ input }) =>
        translated(async () => {
          const base = `obd-read-run-${input.runId}`;
          if (input.format === "csv") {
            return {
              filename: `${base}.csv`,
              mediaType: "text/csv",
              content: await exportRunCsvText(storage, input.runId),
            };
          }
          return {
            filename: `${base}.json`,
            mediaType: "application/json",
            content: JSON.stringify(await exportRunJson(storage, input.runId)),
          };
        }),
      ),
    },
    live: {
      samples: os.live.samples.handler(({ input, signal }) => hub.subscribe(input.runId, signal)),
    },
    profiles: {
      import: os.profiles.import.handler(({ input }) =>
        translated(async () => {
          const document = parseJson(input.json, "imported profile");
          const problems = checkProfile(document, "imported profile");
          if (problems.length > 0) throw new ProfileError(problems);
          const profile = parseProfile(document, "imported profile");
          const { replaced } = await storage.saveProfile({
            name: profile.name,
            importedAt: now(),
            document: jsonSchema.parse(document),
          });
          return { name: profile.name, description: profile.description, replaced };
        }),
      ),
      list: os.profiles.list.handler(() =>
        translated(async () => (await storage.listProfiles()).map((profile) => profile.name)),
      ),
    },
  });
}

/**
 * Builds the diagnostics service over `dependencies`.
 *
 * Handlers translate {@link StorageError} and `ProfileError` into oRPC errors with codes `NOT_FOUND`, `CONFLICT` and `BAD_REQUEST`; anything else surfaces as an internal error.
 */
export function createDiagnosticsHost(dependencies: DiagnosticsDependencies): DiagnosticsHost {
  const router = buildRouter(dependencies);
  return { router, client: createRouterClient(router) };
}

export type { DiagnosticsContract };
