import {
  MemoryStorage,
  createDiagnosticsHost,
  type Collector,
  type DiagnosticsHost,
  type Run,
  type SampleSink,
} from "../../src/core/index.js";

/** A collector that records what it was asked and keeps the sink it was given, so a test can feed samples as the live layer would. */
export class FakeCollector implements Collector {
  readonly started: { run: Run; signals: readonly string[] | undefined }[] = [];
  readonly stopped: string[] = [];
  sink: SampleSink | undefined;
  failWith: Error | undefined;

  start(run: Run, signals: readonly string[] | undefined, sink: SampleSink): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.started.push({ run, signals });
    this.sink = sink;
    return Promise.resolve();
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
  const host = createDiagnosticsHost({ storage, collector, now: () => clock.time });
  return { host, collector, storage, clock };
}
