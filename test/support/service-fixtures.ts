import {
  DeviceGrants,
  DeviceLink,
  MemoryStorage,
  createDiagnosticsHost,
  registryTransportHost,
  type CollectionRequest,
  type CollectionStatus,
  type Collector,
  type DiagnosticsHost,
  type Run,
  type SampleSink,
} from "../../src/core/index.js";
import { shippedPlans } from "../../src/plans/index.js";
import { loadBuiltinProfile } from "../../src/profiles/index.js";

/** A collector that records what it was asked and keeps the sink it was given, so a test can feed samples as the live layer would. */
export class FakeCollector implements Collector {
  readonly started: {
    run: Run;
    signals: readonly string[] | undefined;
    request: CollectionRequest;
  }[] = [];
  readonly stopped: string[] = [];
  sink: SampleSink | undefined;
  failWith: Error | undefined;

  start(run: Run, request: CollectionRequest, sink: SampleSink): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.started.push({ run, signals: request.signals, request });
    this.sink = sink;
    return Promise.resolve();
  }

  active(): readonly string[] {
    return this.started.map((start) => start.run.id).filter((id) => !this.stopped.includes(id));
  }

  status(runId: string): CollectionStatus | undefined {
    return this.active().includes(runId)
      ? { state: "collecting", attempt: 0, lastError: null, samples: 0 }
      : undefined;
  }

  stop(runId: string): Promise<void> {
    this.stopped.push(runId);
    return Promise.resolve();
  }
}

/** A host over in-memory storage and a fake collector, with a clock the test sets. */
export function newHost(): {
  host: DiagnosticsHost;
  collector: FakeCollector;
  storage: MemoryStorage;
  clock: { time: number };
} {
  const collector = new FakeCollector();
  const storage = new MemoryStorage();
  const clock = { time: 1_700_000_000_000 };
  const transports = registryTransportHost();
  const link = new DeviceLink({
    transports,
    loadProfile: (name) => Promise.resolve(loadBuiltinProfile(name)),
  });
  const host = createDiagnosticsHost({
    storage,
    collector,
    link,
    transports,
    grants: new DeviceGrants(),
    now: () => clock.time,
    loadProfile: (name) => Promise.resolve(loadBuiltinProfile(name)),
    toolVersion: "test",
    plans: shippedPlans,
  });
  return { host, collector, storage, clock };
}
