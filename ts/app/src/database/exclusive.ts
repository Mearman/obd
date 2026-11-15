import { DatabaseUnavailableError } from "obd-read/web/storage";

/**
 * The part of the Web Locks API's `LockManager` this module uses, so a test can stand in for it.
 */
export interface ExclusiveLocks {
  request(
    name: string,
    options: { readonly ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void>;
}

/** The lock name that makes a second tab detectable before it touches the database pool. */
export const DATABASE_LOCK = "obd-read-database";

/**
 * Takes the named lock if nobody holds it and keeps it until the worker's global scope ends (the browser releases a lock when its owner goes away), so it works as an exclusive "this origin's database is open" flag.
 *
 * Resolves once the lock is held. Rejects with {@link DatabaseUnavailableError} (`in-use`) when another tab or window already holds it. Checking this before installing the SQLite file pool matters: a failed pool initialisation in a second context must not run, because the pool's default failure path deletes its storage.
 */
export function holdExclusiveLock(locks: ExclusiveLocks, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          reject(
            new DatabaseUnavailableError(
              "in-use",
              "The database is open in another tab or window of this app.",
            ),
          );
          return Promise.resolve();
        }
        resolve();
        return new Promise<void>(() => {
          // Held for the life of the worker.
        });
      })
      .catch(reject);
  });
}
