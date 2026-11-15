/**
 * The part of the Web Locks API's `LockManager` this module uses, so a test can stand in for it.
 *
 * With `ifAvailable: true` the callback runs at once, with `null` when another context holds the lock. Without it the request waits in the lock's queue and the callback runs once the lock is granted.
 */
export interface ExclusiveLocks {
  request(
    name: string,
    options: { readonly ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void>;
}

/** What the database worker tells its page about the lock: it is waiting behind another tab, it holds it, or it cannot take it. */
export type LockStatus =
  | { readonly kind: "database-lock"; readonly state: "queued" | "held" }
  | { readonly kind: "database-lock"; readonly state: "failed"; readonly message: string };

/** Narrows a message from the database worker to a {@link LockStatus}, or returns undefined for any other message. */
export function readLockStatus(data: unknown): LockStatus | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("kind" in data) || data.kind !== "database-lock" || !("state" in data)) return undefined;
  const { state } = data;
  if (state === "queued" || state === "held") return { kind: "database-lock", state };
  if (state === "failed" && "message" in data && typeof data.message === "string") {
    return { kind: "database-lock", state, message: data.message };
  }
  return undefined;
}

/** The lock name that makes the one context allowed to open the database pool detectable. */
export const DATABASE_LOCK = "obd-read-database";

/**
 * Takes the named lock in exclusive mode and keeps it until the worker's global scope ends (the browser releases a lock when its owner goes away), so it works as an exclusive "this context has the database open" flag.
 *
 * Resolves once the lock is held. When another tab or window holds it, `queued` is called and the request waits in the lock's queue, so this context takes over the moment the holder goes away. Taking the lock before installing the SQLite file pool matters: the pool allows one connection, and a pool initialisation that fails because another context has it open must not run.
 *
 * @throws The lock manager's own failure.
 */
export async function holdDatabaseLock(
  locks: ExclusiveLocks,
  name: string,
  queued: () => void,
): Promise<void> {
  const keep = () =>
    new Promise<void>(() => {
      // Held for the life of the worker.
    });
  const granted = await new Promise<boolean>((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock === null ? Promise.resolve() : keep();
      })
      .catch(reject);
  });
  if (granted) return;
  queued();
  await new Promise<void>((resolve, reject) => {
    locks
      .request(name, {}, () => {
        resolve();
        return keep();
      })
      .catch(reject);
  });
}
