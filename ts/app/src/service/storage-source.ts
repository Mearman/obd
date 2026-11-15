import { MemoryStorage, type Storage } from "obd-read";

/**
 * The storage the service worker uses, which is whatever the page's database is at the moment.
 *
 * The page opens the database and decides what the service works over: requests wait while it is opening, go to the database once it is ready, and go to a fresh in-memory store when the database cannot be used (the app tells the user nothing will be saved). The worker asks {@link current} for every request, so a retry that opens a different database takes effect without restarting the worker.
 */
export class StorageSource {
  private decided = deferred<Storage>();
  private settled = false;

  /** The storage a request should use, once there is one. */
  current = (): Promise<Storage> => this.decided.promise;

  /** The database is opening: requests that arrive now wait. */
  opening(): void {
    if (!this.settled) return;
    this.decided = deferred<Storage>();
    this.settled = false;
  }

  /** The database opened: requests use it. */
  ready(storage: Storage): void {
    this.opening();
    this.decided.resolve(storage);
    this.settled = true;
  }

  /** The database cannot be used: requests use memory, which a reload loses. */
  unavailable(): void {
    this.ready(new MemoryStorage());
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
