// @vitest-environment node
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { createDatabaseControl, serveSqlExecutor, openWorkerStorage } from "obd-read/web/storage";
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseHost, type DatabaseFiles } from "../src/database/host";
import { messagePair } from "./message-pair";

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/**
 * Database files held in memory: the file's bytes are the last serialisation, so a reopen sees only what `read` returned, as a reopen from OPFS sees only what reached the file.
 */
function memoryFiles(): DatabaseFiles & { opened: Database[] } {
  let bytes: Uint8Array | undefined;
  const opened: Database[] = [];
  return {
    vfs: "memory",
    opened,
    open() {
      const database = new sqlite3.oo1.DB({ filename: ":memory:" });
      if (bytes !== undefined) {
        const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
        const code = sqlite3.capi.sqlite3_deserialize(
          database.pointer ?? 0,
          "main",
          pointer,
          bytes.length,
          bytes.length,
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
        );
        expect(code).toBe(0);
      }
      opened.push(database);
      return database;
    },
    read() {
      const database = opened[opened.length - 1];
      if (database === undefined) throw new Error("not open");
      return sqlite3.capi.sqlite3_js_db_export(database.pointer ?? 0);
    },
    replace(next) {
      bytes = next;
      return Promise.resolve();
    },
  };
}

function open(files = memoryFiles(), persisted: boolean | null = true) {
  return DatabaseHost.open({
    sqlite3,
    files,
    persistence: {
      request: () => Promise.resolve(persisted),
      check: () => Promise.resolve(persisted),
    },
  });
}

describe("the database host", () => {
  it("applies the migrations on open and runs statements with all three methods", async () => {
    const host = await open();
    await host.execute("CREATE TABLE t (a integer, b text)", [], "run");
    await host.execute("INSERT INTO t VALUES (?, ?), (?, ?)", [1, "x", 2, null], "run");
    expect(await host.execute("SELECT a, b FROM t ORDER BY a", [], "all")).toEqual([
      [1, "x"],
      [2, null],
    ]);
    expect(await host.execute("SELECT a FROM t ORDER BY a DESC", [], "get")).toEqual([[2]]);
    expect(await host.execute("SELECT a FROM t WHERE a > 9", [], "get")).toEqual([]);
    expect(await host.execute("SELECT count(*) FROM obd_migrations", [], "get")).not.toEqual([[0]]);
  });

  it("rejects a failing statement and a parameter it cannot bind", async () => {
    const host = await open();
    await expect(host.execute("SELECT * FROM missing", [], "all")).rejects.toThrow(/no such table/);
    await expect(host.execute("SELECT ?", [{}], "all")).rejects.toThrow(/cannot bind/);
  });

  it("serves the storage through the message port end to end", async () => {
    const host = await open();
    const [page, worker] = messagePair();
    serveSqlExecutor(worker, host.execute, host);
    const storage = await openWorkerStorage(page);
    const run = await storage.createRun({ profile: "p", adapter: "a", startedAt: 5 });
    await storage.appendSamples([
      { runId: run.id, signal: "rpm", unit: "rpm", timestamp: 5, value: 900 },
    ]);
    expect(await storage.readSamples({ runId: run.id })).toHaveLength(1);
    const control = createDatabaseControl(page);
    expect(await control.info()).toMatchObject({ vfs: "memory", persisted: true });
  });

  it("describes the database, including an unknown persistence grant", async () => {
    const host = await open(memoryFiles(), null);
    const info = await host.info();
    expect(info.sqliteVersion).toBe(sqlite3.version.libVersion);
    expect(info.persisted).toBeNull();
    expect(info.bytes).toBeGreaterThan(0);
  });

  it("exports a database file that opens as SQLite and imports it back", async () => {
    const files = memoryFiles();
    const host = await open(files);
    await host.execute("CREATE TABLE kept (a integer)", [], "run");
    await host.execute("INSERT INTO kept VALUES (1)", [], "run");
    const snapshot = await host.exportFile();
    expect(new TextDecoder().decode(snapshot.subarray(0, 15))).toBe("SQLite format 3");

    await host.execute("INSERT INTO kept VALUES (2)", [], "run");
    await host.importFile(snapshot);
    expect(await host.execute("SELECT a FROM kept", [], "all")).toEqual([[1]]);
    // The connection is usable after an import and the migrations table is intact.
    await host.execute("INSERT INTO kept VALUES (3)", [], "run");
    expect(await host.execute("SELECT count(*) FROM kept", [], "get")).toEqual([[2]]);
  });

  it("refuses a file that is not an obd-read database and leaves the data alone", async () => {
    const host = await open();
    await host.execute("CREATE TABLE kept (a integer)", [], "run");

    await expect(host.importFile(new TextEncoder().encode("not a database"))).rejects.toThrow(
      /not a SQLite database/,
    );

    const other = new sqlite3.oo1.DB({ filename: ":memory:" });
    other.exec("CREATE TABLE foreign_table (a integer)");
    const foreign = sqlite3.capi.sqlite3_js_db_export(other.pointer ?? 0);
    other.close();
    await expect(host.importFile(foreign)).rejects.toThrow(/not made by obd-read/);

    const newer = new sqlite3.oo1.DB({ filename: ":memory:" });
    newer.exec("CREATE TABLE obd_migrations (tag text PRIMARY KEY NOT NULL)");
    newer.exec("INSERT INTO obd_migrations VALUES ('9999_from_the_future')");
    const future = sqlite3.capi.sqlite3_js_db_export(newer.pointer ?? 0);
    newer.close();
    await expect(host.importFile(future)).rejects.toThrow(/newer version/);

    expect(await host.execute("SELECT count(*) FROM kept", [], "get")).toEqual([[0]]);
  });
});
