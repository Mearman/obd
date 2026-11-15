import type { Storage } from "obd-read";
import {
  createDatabaseControl,
  openWorkerStorage,
  type DatabaseControl,
} from "obd-read/web/storage";

/** An open database: the storage the app reads and writes, and the database file controls. */
export interface DatabaseConnection {
  readonly storage: Storage;
  readonly control: DatabaseControl;
}

/** A database worker and the connection it is opening. */
export interface DatabaseSession {
  /** Resolves once the worker has opened the database and applied the migrations. Rejects with `DatabaseUnavailableError` when it cannot be used. */
  readonly connection: Promise<DatabaseConnection>;
  /** Ends the worker, which releases the database to another tab. */
  close(): void;
}

/**
 * Starts the database worker and opens the storage on it.
 *
 * Call it once per page and keep the result: a second worker in the same page contends with the first for the database.
 */
export function startDatabaseSession(): DatabaseSession {
  const worker = new Worker(new URL("./database.worker.ts", import.meta.url), { type: "module" });
  const opened = openWorkerStorage(worker).then((storage) => ({
    storage,
    control: createDatabaseControl(worker),
  }));
  // A script that fails to load or throws at the top level never answers a request.
  const failed = new Promise<never>((_resolve, reject) => {
    worker.addEventListener("error", (event) => {
      reject(new Error(event.message || "The database worker failed to start."));
    });
  });
  const connection = Promise.race([opened, failed]);
  return {
    connection,
    close: () => {
      worker.terminate();
    },
  };
}
