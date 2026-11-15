/**
 * The seam between the SQL storage and whatever runs SQL: an executor a platform injects.
 *
 * Node supplies one over `node:sqlite` (`obd-read/node`); the browser supplies one that posts the SQL to a worker that owns the database (`obd-read/web`). Nothing in this directory knows which.
 */

import type { SqliteProxyExecutors } from "drizzle-orm/sqlite-proxy";

/**
 * How a statement's result is wanted: `run` for a statement whose rows are not read (the executor returns none), `get` for the first row only, `all` for every row.
 */
export type SqlMethod = "run" | "get" | "all";

/** One result row as its column values in select order. Values are `null`, numbers, strings or bytes. */
export type SqlRow = readonly unknown[];

/**
 * Runs one SQL statement with its positional parameters and returns the rows it produced: none for `run`, at most one for `get`, all for `all`.
 *
 * An executor is a single connection: the storage serialises its calls, so an executor need not guard against interleaved statements, but it must run them in the order received and reject (never resolve with partial rows) when SQLite reports an error.
 */
export type SqlExecutor = (
  sql: string,
  params: readonly unknown[],
  method: SqlMethod,
) => Promise<SqlRow[]>;

/** Drizzle asked for rows as objects, which the storage's own queries never do. */
export class RowModeError extends Error {
  override name = "RowModeError";
}

function arrayRows(rowMode: "array" | "object" | undefined): void {
  if (rowMode === "object") {
    throw new RowModeError("this storage reads rows as arrays; object rows were requested");
  }
}

/** Adapts an {@link SqlExecutor} to the executors Drizzle's `sqlite-proxy` driver takes. */
export function proxyExecutors(execute: SqlExecutor): SqliteProxyExecutors {
  return {
    all: async (sql, params, rowMode) => {
      arrayRows(rowMode);
      return (await execute(sql, params, "all")).map((row) => [...row]);
    },
    get: async (sql, params, rowMode) => {
      arrayRows(rowMode);
      const [row] = await execute(sql, params, "get");
      return row === undefined ? undefined : [...row];
    },
    run: async (sql, params) => {
      await execute(sql, params, "run");
    },
  };
}
