/**
 * Browser storage: the SQLite {@link Storage} with its SQL run by a worker that owns the database.
 *
 * The page never opens the database. It posts each statement to a dedicated worker over a message port and awaits the rows, so one connection (the sqlite-wasm database on the Origin Private File System) serves the whole app. This module defines the port interface and the message protocol, the executor and the database file controls that use them, and the serving half a worker runs around its own executor. The sqlite-wasm worker itself lives in the app.
 *
 * It imports nothing platform-specific, so a worker bundle can import it through `obd-read/web/storage` without registering the browser transports.
 */

import type { Storage } from "../core/storage.js";
import {
  openDrizzleStorage,
  type DrizzleStorageOptions,
  type SqlExecutor,
  type SqlMethod,
  type SqlRow,
} from "../storage/index.js";

export { applyMigrations, MIGRATIONS } from "../storage/index.js";
export type { Migration, SqlExecutor, SqlMethod, SqlRow } from "../storage/index.js";

/**
 * Why a database cannot be used: `in-use` when another tab or window of the same origin holds it (the Origin Private File System pool allows one connection), `unsupported` when the browser lacks what the database needs.
 */
export type DatabaseUnavailableReason = "in-use" | "unsupported";

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
      /** Present when the failure is that the database cannot be used at all, not that one statement failed. */
      readonly unavailable?: DatabaseUnavailableReason;
    };

/** What the database reports about itself. */
export interface DatabaseInfo {
  /** The SQLite library version. */
  readonly sqliteVersion: string;
  /** The virtual file system the database is on. */
  readonly vfs: string;
  /** The size of the database file in bytes. */
  readonly bytes: number;
  /** Whether the browser granted persistent storage, so it will not evict the database; `null` when the browser has no such API in the worker. */
  readonly persisted: boolean | null;
}

/** A request for the database file itself: its description, its bytes, or a replacement. `id` pairs the reply with it. */
export type DatabaseRequest =
  | { readonly kind: "db-request"; readonly id: number; readonly op: "info" }
  | { readonly kind: "db-request"; readonly id: number; readonly op: "export" }
  | {
      readonly kind: "db-request";
      readonly id: number;
      readonly op: "import";
      readonly bytes: Uint8Array;
    };

/** The worker's reply to the {@link DatabaseRequest} with the same `id`. */
export type DatabaseResponse =
  | {
      readonly kind: "db-response";
      readonly id: number;
      readonly ok: true;
      readonly result:
        | { readonly op: "info"; readonly info: DatabaseInfo }
        | { readonly op: "export"; readonly bytes: Uint8Array }
        | { readonly op: "import" };
    }
  | {
      readonly kind: "db-response";
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly unavailable?: DatabaseUnavailableReason;
    };

/** A message either side of the channel sends. */
export type SqlMessage = SqlRequest | SqlResponse | DatabaseRequest | DatabaseResponse;

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

/** The database cannot be used at all: see {@link DatabaseUnavailableReason}. */
export class DatabaseUnavailableError extends SqlWorkerError {
  override name = "DatabaseUnavailableError";
  readonly reason: DatabaseUnavailableReason;

  constructor(reason: DatabaseUnavailableReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function failure(error: unknown): {
  readonly error: string;
  readonly unavailable?: DatabaseUnavailableReason;
} {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof DatabaseUnavailableError
    ? { error: message, unavailable: error.reason }
    : { error: message };
}

function workerError(message: {
  readonly error: string;
  readonly unavailable?: DatabaseUnavailableReason;
}): SqlWorkerError {
  return message.unavailable === undefined
    ? new SqlWorkerError(message.error)
    : new DatabaseUnavailableError(message.unavailable, message.error);
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

/** Narrows a received message to a database file request. */
export function isDatabaseRequest(data: unknown): data is DatabaseRequest {
  return isRecord(data) && data.kind === "db-request";
}

function isDatabaseResponse(data: unknown): data is DatabaseResponse {
  return isRecord(data) && data.kind === "db-response";
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
    else waiting.reject(workerError(message));
  });
  return (sql, params, method) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      port.postMessage({ kind: "sql-request", id: nextId, sql, params, method });
    });
}

/** What a worker does for the database file itself; the page-side {@link createDatabaseControl} has the same shape. */
export interface DatabaseControl {
  /** Describes the database. */
  info(): Promise<DatabaseInfo>;
  /** The database file's bytes: a complete SQLite database any SQLite tool opens. */
  exportFile(): Promise<Uint8Array>;
  /**
   * Replaces the database with the given SQLite file. The file is checked first and a file that is not an obd-read database leaves the current one untouched, rejecting with the reason.
   */
  importFile(bytes: Uint8Array): Promise<void>;
}

/**
 * The page's handle on the database file in the worker on the other end of `port`.
 *
 * Calls are answered in order with the SQL statements, so an import never lands in the middle of a multi-statement storage call that was queued before it. A failure rejects with {@link SqlWorkerError}, or {@link DatabaseUnavailableError} when the database cannot be used.
 */
export function createDatabaseControl(port: SqlMessagePort): DatabaseControl {
  const pending = new Map<
    number,
    {
      readonly resolve: (result: Extract<DatabaseResponse, { ok: true }>["result"]) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  let nextId = 0;
  port.addEventListener("message", (event) => {
    const message = event.data;
    if (!isDatabaseResponse(message)) return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(workerError(message));
  });
  const call = (
    request: (id: number) => DatabaseRequest,
  ): Promise<Extract<DatabaseResponse, { ok: true }>["result"]> =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      port.postMessage(request(nextId));
    });
  return {
    info: async () => {
      const result = await call((id) => ({ kind: "db-request", id, op: "info" }));
      if (result.op !== "info")
        throw new SqlWorkerError("the worker answered info with another result");
      return result.info;
    },
    exportFile: async () => {
      const result = await call((id) => ({ kind: "db-request", id, op: "export" }));
      if (result.op !== "export")
        throw new SqlWorkerError("the worker answered export with another result");
      return result.bytes;
    },
    importFile: async (bytes) => {
      const result = await call((id) => ({ kind: "db-request", id, op: "import", bytes }));
      if (result.op !== "import")
        throw new SqlWorkerError("the worker answered import with another result");
    },
  };
}

/**
 * Answers the requests arriving on `port` by running them on `execute`, and the database file requests on `control` when given: what the database worker does around its sqlite-wasm executor.
 *
 * Requests of both kinds are run one after another in arrival order, whatever the executor's own concurrency. Returns a function that stops listening.
 */
export function serveSqlExecutor(
  port: SqlMessagePort,
  execute: SqlExecutor,
  control?: DatabaseControl,
): () => void {
  let queue: Promise<void> = Promise.resolve();
  const listener = (event: { readonly data: unknown }): void => {
    const request = event.data;
    if (isSqlRequest(request)) {
      queue = queue.then(async () => {
        try {
          const rows = await execute(request.sql, request.params, request.method);
          port.postMessage({ kind: "sql-response", id: request.id, ok: true, rows });
        } catch (error) {
          port.postMessage({ kind: "sql-response", id: request.id, ok: false, ...failure(error) });
        }
      });
    } else if (isDatabaseRequest(request)) {
      queue = queue.then(async () => {
        try {
          if (control === undefined) throw new SqlWorkerError("this worker has no database file");
          const result = await serveDatabaseRequest(control, request);
          port.postMessage({ kind: "db-response", id: request.id, ok: true, result });
        } catch (error) {
          port.postMessage({ kind: "db-response", id: request.id, ok: false, ...failure(error) });
        }
      });
    }
  };
  port.addEventListener("message", listener);
  return () => {
    port.removeEventListener("message", listener);
  };
}

async function serveDatabaseRequest(
  control: DatabaseControl,
  request: DatabaseRequest,
): Promise<Extract<DatabaseResponse, { ok: true }>["result"]> {
  switch (request.op) {
    case "info":
      return { op: "info", info: await control.info() };
    case "export":
      return { op: "export", bytes: await control.exportFile() };
    case "import":
      await control.importFile(request.bytes);
      return { op: "import" };
  }
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
