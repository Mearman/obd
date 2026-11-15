/**
 * Browser storage: the SQLite {@link Storage} with its SQL run by a worker that owns the database.
 *
 * The page never opens the database. It posts each statement to a dedicated worker over a message port and awaits the rows, so one connection (the sqlite-wasm database on the Origin Private File System, once that worker exists) serves the whole app. This module defines the port interface and the message protocol, the executor that uses them and the serving half a worker runs around its own executor. The sqlite-wasm worker itself is not part of this module.
 */

import type { Storage } from "../core/storage.js";
import {
  openDrizzleStorage,
  type DrizzleStorageOptions,
  type SqlExecutor,
  type SqlMethod,
  type SqlRow,
} from "../storage/index.js";

/** A statement the page asks the worker to run. `id` pairs the reply with it. */
export interface SqlRequest {
  readonly kind: "sql-request";
  readonly id: number;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: SqlMethod;
}

/** The worker's reply to the request with the same `id`: the rows, or the error's message. */
export type SqlResponse =
  | {
      readonly kind: "sql-response";
      readonly id: number;
      readonly ok: true;
      readonly rows: SqlRow[];
    }
  | {
      readonly kind: "sql-response";
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

/** A message either side of the SQL channel sends. */
export type SqlMessage = SqlRequest | SqlResponse;

/**
 * The part of a `Worker`, `MessagePort` or `DedicatedWorkerGlobalScope` this module uses. Messages are structured-cloned, so they carry only plain data.
 */
export interface SqlMessagePort {
  postMessage(message: SqlMessage): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

/** The worker reported that a statement failed, or the port closed before it answered. */
export class SqlWorkerError extends Error {
  override name = "SqlWorkerError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows a received message to a request. */
export function isSqlRequest(data: unknown): data is SqlRequest {
  return isRecord(data) && data.kind === "sql-request";
}

function isSqlResponse(data: unknown): data is SqlResponse {
  return isRecord(data) && data.kind === "sql-response";
}

/**
 * An {@link SqlExecutor} that runs each statement in the worker on the other end of `port`.
 *
 * Replies are matched to requests by id, so statements may be in flight together; the worker runs them in arrival order. A failed statement rejects with {@link SqlWorkerError} carrying the worker's message.
 */
export function createWorkerExecutor(port: SqlMessagePort): SqlExecutor {
  const pending = new Map<
    number,
    { readonly resolve: (rows: SqlRow[]) => void; readonly reject: (error: Error) => void }
  >();
  let nextId = 0;
  port.addEventListener("message", (event) => {
    const message = event.data;
    if (!isSqlResponse(message)) return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.rows);
    else waiting.reject(new SqlWorkerError(message.error));
  });
  return (sql, params, method) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      port.postMessage({ kind: "sql-request", id: nextId, sql, params, method });
    });
}

/**
 * Answers the requests arriving on `port` by running them on `execute`: what the database worker does around its sqlite-wasm executor.
 *
 * Requests are run one after another in arrival order, whatever the executor's own concurrency. Returns a function that stops listening.
 */
export function serveSqlExecutor(port: SqlMessagePort, execute: SqlExecutor): () => void {
  let queue: Promise<void> = Promise.resolve();
  const listener = (event: { readonly data: unknown }): void => {
    const request = event.data;
    if (!isSqlRequest(request)) return;
    queue = queue.then(async () => {
      try {
        const rows = await execute(request.sql, request.params, request.method);
        port.postMessage({ kind: "sql-response", id: request.id, ok: true, rows });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        port.postMessage({ kind: "sql-response", id: request.id, ok: false, error: message });
      }
    });
  };
  port.addEventListener("message", listener);
  return () => {
    port.removeEventListener("message", listener);
  };
}

/**
 * Opens the {@link Storage} whose database lives in the worker on the other end of `port`, applying any pending migrations through it.
 */
export function openWorkerStorage(
  port: SqlMessagePort,
  options: DrizzleStorageOptions = {},
): Promise<Storage> {
  return openDrizzleStorage(createWorkerExecutor(port), options);
}
