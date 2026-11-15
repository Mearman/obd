import { DatabaseUnavailableError } from "obd-read/web/storage";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { DatabaseFiles, Persistence } from "./host";

/** The file's path in the pool; paths in this VFS must be absolute. */
const DATABASE_PATH = "/obd-read.sqlite3";

/**
 * Pool slots to reserve: each database file and its rollback journal take one, and SQLite may add a temporary file. Only applies while the pool is empty.
 */
const POOL_CAPACITY = 12;

/** Whether the browser has the OPFS pieces the pool needs: `getDirectory` and synchronous access handles. */
function hasOpfs(): boolean {
  return (
    typeof navigator.storage.getDirectory === "function" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype
  );
}

/**
 * Installs the `opfs-sahpool` VFS and returns the database file on it.
 *
 * That VFS needs no cross-origin isolation headers and allows one connection, which the caller guarantees with {@link holdExclusiveLock} before calling. `preserveOnInitFailure` stops a failed installation from wiping the pool's storage, which is the library's default.
 *
 * @throws {@link DatabaseUnavailableError} (`unsupported`) when the browser lacks OPFS, or (`in-use`) when the pool's file handles are held elsewhere.
 */
export async function openSahpoolFiles(sqlite3: Sqlite3Static): Promise<DatabaseFiles> {
  if (!hasOpfs()) {
    throw new DatabaseUnavailableError(
      "unsupported",
      "This browser has no Origin Private File System with synchronous access.",
    );
  }
  const pool = await sqlite3
    .installOpfsSAHPoolVfs({ initialCapacity: POOL_CAPACITY, preserveOnInitFailure: true })
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "NoModificationAllowedError") {
        throw new DatabaseUnavailableError(
          "in-use",
          "The database is open in another tab or window of this app.",
        );
      }
      throw error;
    });
  return {
    vfs: pool.vfsName,
    open: () => new pool.OpfsSAHPoolDb(DATABASE_PATH),
    read: () => pool.exportFile(DATABASE_PATH),
    replace: async (bytes) => {
      await pool.importDb(DATABASE_PATH, bytes);
    },
  };
}

/**
 * Persistent-storage requests through `navigator.storage`, which is exposed to dedicated workers. Chrome decides the grant without a prompt, from signals such as the app being installed or bookmarked.
 */
export const storagePersistence: Persistence = {
  request: async () =>
    typeof navigator.storage.persist === "function" ? navigator.storage.persist() : null,
  check: async () =>
    typeof navigator.storage.persisted === "function" ? navigator.storage.persisted() : null,
};
