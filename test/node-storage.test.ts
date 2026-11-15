import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor, openNodeStorage } from "../src/node/index.js";
import { describeStorageContract } from "./support/storage-contract.js";

describeStorageContract("Drizzle over node:sqlite", async () => {
  const storage = await openNodeStorage(":memory:");
  return {
    storage,
    dispose: () => {
      storage.close();
    },
  };
});

describe("openNodeStorage", () => {
  it("is exported with its executor", () => {
    expect(typeof createNodeSqliteExecutor).toBe("function");
  });
});
