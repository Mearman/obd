import type { Storage } from "obd-read";
import {
  DatabaseUnavailableError,
  createDatabaseControl,
  openWorkerStorage,
  type DatabaseControl,
} from "obd-read/web/storage";
import { readLockStatus } from "./exclusive";
import { TAB_CHANNEL, shareDatabase } from "./tab-share";

/** An open database: the storage the app reads and writes, and the database file controls. */
export interface DatabaseConnection {
  readonly storage: Storage;
  readonly control: DatabaseControl;
}

/** A database worker and the connection it is opening. */
export interface DatabaseSession {
  /** Resolves once the database answers, whichever tab has it open. Rejects with `DatabaseUnavailableError` when it cannot be used. */
  readonly connection: Promise<DatabaseConnection>;
  /** Calls `listener` after any tab of the app writes to the database. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Ends the worker, which releases the database to another tab. */
  close(): void;
}

/**
 * Long enough for a busy page to answer a broadcast message; see `TabShareOptions.answerLimit`.
 */
const ANSWER_LIMIT_MS = 5_000;

/**
 * Starts the database worker and joins the other tabs of the app in sharing the database (`shareDatabase`): this tab opens it when its worker holds the lock, and otherwise uses the tab that does.
 *
 * Call it once per page and keep the result: a second worker in the same page queues for the database behind the first.
 */
export function startDatabaseSession(): DatabaseSession {
  const worker = new Worker(new URL("./database.worker.ts", import.meta.url), { type: "module" });
  // A script that fails to load or throws at the top level never reports on the lock.
  const failed = new Promise<never>((_resolve, reject) => {
    worker.addEventListener("error", (event) => {
      reject(new Error(event.message || "The database worker failed to start."));
    });
  });
  failed.catch(() => undefined);
  const lock = (queued: () => void): Promise<void> => {
    if (typeof navigator.locks !== "object") {
      return Promise.reject(
        new DatabaseUnavailableError("unsupported", "This browser has no Web Locks API."),
      );
    }
    const held = new Promise<void>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const status = readLockStatus(event.data);
        if (status?.state === "queued") queued();
        else if (status?.state === "held") resolve();
        else if (status?.state === "failed") reject(new Error(status.message));
      });
    });
    return Promise.race([held, failed]);
  };
  const shared = shareDatabase({
    id: crypto.randomUUID(),
    channel: new BroadcastChannel(TAB_CHANNEL),
    lock,
    open: () =>
      Promise.race([
        openWorkerStorage(worker).then((storage) => ({
          storage,
          control: createDatabaseControl(worker),
        })),
        failed,
      ]),
    answerLimit: ANSWER_LIMIT_MS,
  });
  return {
    connection: shared.connection,
    subscribe: (listener) => shared.subscribe(listener),
    close: () => {
      shared.close();
      worker.terminate();
    },
  };
}
