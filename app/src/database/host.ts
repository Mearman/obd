import {
  MIGRATIONS,
  SqlWorkerError,
  applyMigrations,
  type DatabaseControl,
  type DatabaseInfo,
  type SqlExecutor,
  type SqlRow,
} from "obd-read/web/storage";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/**
 * Where the database file lives, so the host's logic runs the same over the Origin Private File System in the browser and over memory in a test.
 */
export interface DatabaseFiles {
  /** The SQLite VFS name, reported in the database's description. */
  readonly vfs: string;
  /** Opens the database file, creating it when absent. At most one connection is open at a time. */
  open(): Database;
  /** The database file's current bytes; the database may be open. */
  read(): Uint8Array;
  /** Replaces the database file's bytes. Called only while no connection is open. */
  replace(bytes: Uint8Array): Promise<void>;
}

/** Whether the browser keeps the storage from being evicted, requested once and read back later. */
export interface Persistence {
  /** Asks for persistent storage; `null` when the environment has no such API. */
  request(): Promise<boolean | null>;
  /** Reads the current grant; `null` when the environment has no such API. */
  check(): Promise<boolean | null>;
}

/** What {@link openDatabaseHost} needs. */
export interface DatabaseHostOptions {
  readonly sqlite3: Sqlite3Static;
  readonly files: DatabaseFiles;
  readonly persistence: Persistence;
}

/** The SQLite header every database file starts with. */
const SQLITE_MAGIC = "SQLite format 3\0";

type BindValue = null | number | string;

/** Converts a statement parameter to a value SQLite binds; the storage binds only null, numbers and strings. */
function bindable(value: unknown): BindValue {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  throw new TypeError(`cannot bind a ${typeof value} parameter`);
}

/**
 * The database worker's state: one open connection, the SQL executor over it and the file controls.
 *
 * Requests reach it one at a time (see `serveSqlExecutor`), so none of its methods guards against interleaving.
 */
export class DatabaseHost implements DatabaseControl {
  private database: Database;

  private constructor(private readonly options: DatabaseHostOptions) {
    this.database = options.files.open();
  }

  /**
   * Opens the database, requests persistent storage and applies the embedded migrations.
   *
   * @throws When `files.open` fails, for example because another connection holds the file.
   */
  static async open(options: DatabaseHostOptions): Promise<DatabaseHost> {
    await options.persistence.request();
    const host = new DatabaseHost(options);
    await applyMigrations(host.execute);
    return host;
  }

  /** Runs one statement on the open connection; see `SqlExecutor`. */
  readonly execute: SqlExecutor = (sql, params, method) => {
    try {
      const bind = params.map(bindable);
      if (method === "run") {
        this.database.exec({ sql, bind });
        return Promise.resolve([]);
      }
      const rows: SqlRow[] = this.database.exec({
        sql,
        bind,
        rowMode: "array",
        returnValue: "resultRows",
      });
      return Promise.resolve(method === "get" ? rows.slice(0, 1) : rows);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  info(): Promise<DatabaseInfo> {
    const [[pages = 0] = []] = this.database.exec("PRAGMA page_count", {
      rowMode: "array",
      returnValue: "resultRows",
    });
    const [[pageSize = 0] = []] = this.database.exec("PRAGMA page_size", {
      rowMode: "array",
      returnValue: "resultRows",
    });
    return this.options.persistence.check().then((persisted) => ({
      sqliteVersion: this.options.sqlite3.version.libVersion,
      vfs: this.options.files.vfs,
      bytes: Number(pages) * Number(pageSize),
      persisted,
    }));
  }

  exportFile(): Promise<Uint8Array> {
    return Promise.resolve(this.options.files.read());
  }

  async importFile(bytes: Uint8Array): Promise<void> {
    this.validate(bytes);
    this.database.close();
    try {
      await this.options.files.replace(bytes);
    } finally {
      this.database = this.options.files.open();
    }
    await applyMigrations(this.execute);
  }

  /**
   * Checks `bytes` in a scratch in-memory database without touching the real one.
   *
   * @throws {@link SqlWorkerError} naming why the file cannot replace the database.
   */
  private validate(bytes: Uint8Array): void {
    const { capi, wasm, oo1 } = this.options.sqlite3;
    if (new TextDecoder().decode(bytes.subarray(0, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) {
      throw new SqlWorkerError("That file is not a SQLite database.");
    }
    const scratch = new oo1.DB({ filename: ":memory:" });
    try {
      const pointer = wasm.allocFromTypedArray(bytes);
      const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
      const code = capi.sqlite3_deserialize(
        scratch.pointer ?? 0,
        "main",
        pointer,
        bytes.length,
        bytes.length,
        flags,
      );
      if (code !== 0) {
        wasm.dealloc(pointer);
        throw new SqlWorkerError("That file is not a SQLite database.");
      }
      const check = scratch.exec("PRAGMA integrity_check", {
        rowMode: "array",
        returnValue: "resultRows",
      });
      if (check.length !== 1 || check[0]?.[0] !== "ok") {
        throw new SqlWorkerError("That database file is damaged.");
      }
      const known = new Set(MIGRATIONS.map((migration) => migration.tag));
      const applied = tags(scratch);
      if (applied === undefined) {
        throw new SqlWorkerError("That database was not made by obd-read.");
      }
      if (applied.some((tag) => !known.has(tag))) {
        throw new SqlWorkerError("That database was made by a newer version of obd-read.");
      }
    } finally {
      scratch.close();
    }
  }
}

/** The migration tags a database records, or undefined when it has no migrations table. */
function tags(database: Database): string[] | undefined {
  try {
    return database
      .exec("SELECT tag FROM obd_migrations", { rowMode: "array", returnValue: "resultRows" })
      .map(([tag]) => (typeof tag === "string" ? tag : ""));
  } catch {
    return undefined;
  }
}
