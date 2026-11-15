import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor } from "../../src/node/index.js";
import {
  SqlWorkerError,
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
