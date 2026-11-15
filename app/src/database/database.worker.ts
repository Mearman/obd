/**
 * The dedicated worker that owns the app's SQLite database.
 *
 * It takes an exclusive Web Lock, waiting in the lock's queue while another tab holds it, and tells the page where it stands (`LockStatus`). Once it holds the lock it installs the `opfs-sahpool` VFS, opens the database on the Origin Private File System, applies the embedded migrations and answers the page's statements and file requests over the message port (`serveSqlExecutor`). A browser without OPFS still answers: every request fails with a `DatabaseUnavailableError` the page turns into a message.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  DatabaseUnavailableError,
  serveSqlExecutor,
  type SqlMessagePort,
} from "obd-read/web/storage";
import { DATABASE_LOCK, holdDatabaseLock, type LockStatus } from "./exclusive";
import { DatabaseHost } from "./host";
import { openSahpoolFiles, storagePersistence } from "./sahpool";

function isPort(value: unknown): value is SqlMessagePort {
  return (
    typeof value === "object" &&
    value !== null &&
    "postMessage" in value &&
    typeof value.postMessage === "function" &&
    "addEventListener" in value
  );
}

function report(status: LockStatus): void {
  self.postMessage(status);
}

async function openDatabase(): Promise<DatabaseHost> {
  if (typeof navigator.locks !== "object") {
    throw new DatabaseUnavailableError("unsupported", "This browser has no Web Locks API.");
  }
  try {
    await holdDatabaseLock(navigator.locks, DATABASE_LOCK, () => {
      report({ kind: "database-lock", state: "queued" });
    });
  } catch (error) {
    report({
      kind: "database-lock",
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  report({ kind: "database-lock", state: "held" });
  const sqlite3 = await sqlite3InitModule();
  const files = await openSahpoolFiles(sqlite3);
  return DatabaseHost.open({ sqlite3, files, persistence: storagePersistence });
}

if (!isPort(globalThis)) throw new Error("database.worker.ts must run in a worker");
const opened = openDatabase();
// A failure is reported to each request that awaits `opened`; this stops an unhandled rejection when none has arrived yet.
opened.catch(() => undefined);

serveSqlExecutor(
  globalThis,
  async (sql, params, method) => (await opened).execute(sql, params, method),
  {
    info: async () => (await opened).info(),
    exportFile: async () => (await opened).exportFile(),
    importFile: async (bytes) => {
      await (await opened).importFile(bytes);
    },
  },
);
