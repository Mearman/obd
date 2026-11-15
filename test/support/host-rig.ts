import {
  DiagProtocol,
  GENERIC_SIMULATOR_URL,
  MemoryStorage,
  TransportError,
  adapterTransport,
  composeTransportHosts,
  createDiagnosticsService,
  isSimulatorUrl,
  profileLoader,
  simulatedLiveCar,
  simulatorTransportHost,
  simulatorUrl,
  type DiagnosticsService,
  type FakeElmCore,
  type Storage,
  type Transport,
  type TransportHost,
} from "../../src/core/index.js";
import { builtinProfileData, loadBuiltinProfile } from "../../src/profiles/index.js";

/** The simulated adapter of the Mercedes profile. */
export const SIMULATOR = simulatorUrl("mercedes-w211");

/** The simulated adapter of a car with no profile. */
export const GENERIC_SIMULATOR = GENERIC_SIMULATOR_URL;

/** A host whose one simulated generic car records every line the tool writes to it. */
export function recordingGenericHost(): { transports: TransportHost; car: FakeElmCore } {
  const car = simulatedLiveCar({ protocol: DiagProtocol.KWP2000, units: new Map() });
  return {
    car,
    transports: {
      schemes: () => [],
      serves: isSimulatorUrl,
      create: () => adapterTransport(car),
    },
  };
}

/** Resolves on the next turn of the event loop, so collection and parked commands make progress. */
export function turn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Polls `check` until it returns a value, failing after a bounded number of turns. */
export async function eventually<T>(
  check: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const found = await check();
    if (found !== undefined) return found;
    await turn();
  }
  throw new Error("the condition never held");
}

/** A transport host over the simulator whose open transports can be made to fail like a dropped link. */
export class FlakyHost implements TransportHost {
  /** Every transport built, oldest first. */
  readonly built: FlakyTransport[] = [];
  private readonly inner = simulatorTransportHost((name) =>
    Promise.resolve(loadBuiltinProfile(name)),
  );

  schemes(): readonly never[] {
    return [];
  }

  serves(adapterUrl: string): boolean {
    return this.inner.serves(adapterUrl);
  }

  create(adapterUrl: string): Transport {
    const transport = new FlakyTransport(this.inner.create(adapterUrl));
    this.built.push(transport);
    return transport;
  }

  /** Drops the link of the newest transport: its next read or write fails. */
  dropCurrent(): void {
    const current = this.built.at(-1);
    if (current === undefined) throw new Error("nothing is connected");
    current.dropped = true;
  }
}

/** A transport that fails every read and write once {@link FlakyTransport.dropped} is set. */
export class FlakyTransport implements Transport {
  dropped = false;
  constructor(private readonly inner: Transport) {}

  open(): Promise<void> {
    return this.inner.open();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.dropped) return Promise.reject(new TransportError("the link dropped"));
    return this.inner.write(data);
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.dropped) return Promise.reject(new TransportError("the link dropped"));
    return this.inner.read(timeoutMs);
  }
}

/** A service over the simulator with a fast collector and a clock the test can read. */
export function newSimulatedService(
  options: {
    storage?: Storage;
    transports?: TransportHost;
    confirmationTtlMs?: number;
    codesMs?: number;
  } = {},
): DiagnosticsService & { storage: Storage; clock: { time: number } } {
  const storage = options.storage ?? new MemoryStorage();
  const clock = { time: 1_700_000_000_000 };
  // As the worker does: an imported profile is preferred over a shipped one of the same name.
  const loadProfile = profileLoader(storage, builtinProfileData);
  const service = createDiagnosticsService({
    toolVersion: "test",
    storage,
    loadProfile,
    transports: options.transports ?? composeTransportHosts(simulatorTransportHost(loadProfile)),
    now: () => (clock.time += 10),
    sleep: turn,
    timing: {
      pollMs: 0,
      flushMs: 0,
      batchSize: 1,
      reconnectDelay: () => 0,
      ...(options.codesMs === undefined ? {} : { codesMs: options.codesMs }),
    },
    ...(options.confirmationTtlMs === undefined
      ? {}
      : { confirmationTtlMs: options.confirmationTtlMs }),
  });
  return { ...service, storage, clock };
}
