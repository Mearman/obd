import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor } from "../../src/node/index.js";
import {
  DatabaseUnavailableError,
  SqlWorkerError,
  createDatabaseControl,
  createWorkerExecutor,
  openWorkerStorage,
  serveSqlExecutor,
} from "../../src/web/index.js";
import { describeStorageContract } from "../support/storage-contract.js";
import { messagePair } from "../support/message-pair.js";

/** A page-side port wired to a worker that serves a `node:sqlite` database. */
function workerOnDatabase(): { port: ReturnType<typeof messagePair>[0]; close: () => void } {
  const database = new DatabaseSync(":memory:");
  const [page, worker] = messagePair();
  const stop = serveSqlExecutor(worker, createNodeSqliteExecutor(database));
  return {
    port: page,
    close: () => {
      stop();
      database.close();
    },
  };
}

describeStorageContract("Drizzle through a message-port worker", async () => {
  const { port, close } = workerOnDatabase();
  return { storage: await openWorkerStorage(port), dispose: close };
});

describe("the worker executor", () => {
  it("returns rows for a query and rejects with the worker's message when SQL fails", async () => {
    const { port, close } = workerOnDatabase();
    try {
      const execute = createWorkerExecutor(port);
      await execute("CREATE TABLE t (a integer, b text)", [], "run");
      await execute("INSERT INTO t VALUES (?, ?), (?, ?)", [1, "x", 2, null], "run");
      expect(await execute("SELECT a, b FROM t ORDER BY a", [], "all")).toEqual([
        [1, "x"],
        [2, null],
      ]);
      expect(await execute("SELECT a FROM t ORDER BY a DESC", [], "get")).toEqual([[2]]);
      const failure = execute("SELECT * FROM missing", [], "all");
      await expect(failure).rejects.toBeInstanceOf(SqlWorkerError);
      await expect(failure).rejects.toThrow(/no such table/);
    } finally {
      close();
    }
  });

  it("matches replies to requests that are in flight together", async () => {
    const { port, close } = workerOnDatabase();
    try {
      const execute = createWorkerExecutor(port);
      const rows = await Promise.all([1, 2, 3].map((n) => execute("SELECT ? + 0", [n], "get")));
      expect(rows).toEqual([[[1]], [[2]], [[3]]]);
    } finally {
      close();
    }
  });

  it("stops answering once the serving side is stopped", async () => {
    const database = new DatabaseSync(":memory:");
    const [page, worker] = messagePair();
    const stop = serveSqlExecutor(worker, createNodeSqliteExecutor(database));
    const execute = createWorkerExecutor(page);
    expect(await execute("SELECT 1", [], "get")).toEqual([[1]]);
    stop();
    const outcome = await Promise.race([
      execute("SELECT 1", [], "get").then(() => "answered"),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          resolve("silent");
        }, 50),
      ),
    ]);
    expect(outcome).toBe("silent");
    database.close();
  });
});

describe("the database file control", () => {
  const info = { sqliteVersion: "3.0.0", vfs: "memory", bytes: 3, persisted: null };

  it("carries info, export and import through the worker in order with the SQL", async () => {
    const database = new DatabaseSync(":memory:");
    const [page, worker] = messagePair();
    const calls: string[] = [];
    const execute = createNodeSqliteExecutor(database);
    serveSqlExecutor(
      worker,
      (sql, params, method) => {
        calls.push(`sql ${sql}`);
        return execute(sql, params, method);
      },
      {
        info: () => Promise.resolve(info),
        exportFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
        importFile: (bytes) => {
          calls.push(`import ${bytes.join(",")}`);
          return Promise.resolve();
        },
      },
    );
    const run = createWorkerExecutor(page);
    const control = createDatabaseControl(page);

    const first = run("CREATE TABLE t (a)", [], "run");
    const imported = control.importFile(new Uint8Array([7, 8]));
    const second = run("SELECT 1", [], "get");
    await Promise.all([first, imported, second]);

    expect(calls).toEqual(["sql CREATE TABLE t (a)", "import 7,8", "sql SELECT 1"]);
    expect(await control.info()).toEqual(info);
    expect(await control.exportFile()).toEqual(new Uint8Array([1, 2, 3]));
    database.close();
  });

  it("rejects a control failure with the worker's message", async () => {
    const [page, worker] = messagePair();
    serveSqlExecutor(worker, () => Promise.resolve([]), {
      info: () => Promise.resolve(info),
      exportFile: () => Promise.resolve(new Uint8Array()),
      importFile: () => Promise.reject(new Error("That file is damaged.")),
    });
    const failure = createDatabaseControl(page).importFile(new Uint8Array([1]));
    await expect(failure).rejects.toBeInstanceOf(SqlWorkerError);
    await expect(failure).rejects.toThrow("That file is damaged.");
  });

  it("answers a worker without a database file with an error", async () => {
    const [page, worker] = messagePair();
    serveSqlExecutor(worker, () => Promise.resolve([]));
    await expect(createDatabaseControl(page).info()).rejects.toThrow(/no database file/);
  });
});

describe("an unavailable database", () => {
  it("rejects statements and file requests with the reason, not as a plain failure", async () => {
    const [page, worker] = messagePair();
    const unavailable = (): Promise<never> =>
      Promise.reject(new DatabaseUnavailableError("in-use", "held elsewhere"));
    serveSqlExecutor(worker, unavailable, {
      info: unavailable,
      exportFile: unavailable,
      importFile: unavailable,
    });

    const statement = createWorkerExecutor(page)("SELECT 1", [], "get");
    await expect(statement).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(statement).rejects.toMatchObject({ reason: "in-use", message: "held elsewhere" });
    await expect(createDatabaseControl(page).exportFile()).rejects.toMatchObject({
      reason: "in-use",
    });
    await expect(openWorkerStorage(page)).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});
