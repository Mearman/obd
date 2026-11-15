/**
 * Node storage: the SQLite {@link Storage} over a `node:sqlite` database, on a file or in memory.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  openDrizzleStorage,
  type DrizzleStorageOptions,
  type SqlExecutor,
} from "../storage/index.js";
import type { Storage } from "../core/storage.js";

/** Converts a statement parameter to the types `node:sqlite` binds; the storage binds only null, numbers, strings and bytes. */
function bindable(value: unknown): SQLInputValue {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`cannot bind a ${typeof value} parameter`);
}

/**
 * An {@link SqlExecutor} over one open `node:sqlite` database. The statements run synchronously, so the executor resolves in the order it is called.
 */
export function createNodeSqliteExecutor(database: DatabaseSync): SqlExecutor {
  return (sql, params, method) => {
    try {
      const statement = database.prepare(sql);
      statement.setReturnArrays(true);
      const bound = params.map(bindable);
      if (method === "run") {
        statement.run(...bound);
        return Promise.resolve([]);
      }
      if (method === "get") {
        const row = statement.get(...bound);
        return Promise.resolve(row === undefined ? [] : [Object.values(row)]);
      }
      return Promise.resolve(statement.all(...bound).map((row) => Object.values(row)));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/** A {@link Storage} that owns an open database and can close it. */
export interface NodeStorage extends Storage {
  /** Closes the database file. Later calls reject. */
  close(): void;
}

/**
 * Opens (creating it if need be) the SQLite database at `path`, or an in-memory one for `":memory:"`, applies the migrations and returns the storage.
 *
 * The file is a plain SQLite database, readable by any SQLite tool and by the browser build's export.
 */
export async function openNodeStorage(
  path: string,
  options: DrizzleStorageOptions = {},
): Promise<NodeStorage> {
  const database = new DatabaseSync(path);
  try {
    const storage = await openDrizzleStorage(createNodeSqliteExecutor(database), options);
    return Object.assign(storage, {
      close: () => {
        database.close();
      },
    });
  } catch (error) {
    database.close();
    throw error;
  }
}
