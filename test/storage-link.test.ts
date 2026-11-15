import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { MemoryStorage, StorageError, type Storage } from "../src/core/index.js";
import { remoteStorage, serveStorage } from "../src/service/storage-link.js";
import { describeStorageContract } from "./support/storage-contract.js";

function linked(current: () => Promise<Storage>) {
  const { port1, port2 } = new MessageChannel();
  serveStorage(port1, current);
  return {
    storage: remoteStorage(port2),
    dispose: () => {
      port1.close();
      port2.close();
    },
  };
}

describeStorageContract("over a message port", () => {
  const backing = new MemoryStorage();
  return Promise.resolve(linked(() => Promise.resolve(backing)));
});

describe("storage served by the page", () => {
  it("holds requests until a storage exists and uses the one current at each request", async () => {
    let release: (storage: Storage) => void = () => undefined;
    let target = new Promise<Storage>((resolve) => {
      release = resolve;
    });
    const { storage, dispose } = linked(() => target);
    try {
      const pending = storage.createRun({ profile: "p", adapter: "a", startedAt: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const first = new MemoryStorage();
      release(first);
      const run = await pending;
      expect(await first.getRun(run.id)).toEqual(run);

      const second = new MemoryStorage();
      target = Promise.resolve(second);
      expect(await storage.getRun(run.id)).toBeUndefined();
      expect((await storage.createRun({ profile: "q", adapter: "a", startedAt: 2 })).profile).toBe(
        "q",
      );
      expect(await second.listRuns()).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("fails a request the supplier rejects, and keeps StorageError codes", async () => {
    let failing = true;
    const backing = new MemoryStorage();
    const { storage, dispose } = linked(() =>
      failing ? Promise.reject(new Error("database unavailable")) : Promise.resolve(backing),
    );
    try {
      await expect(storage.listRuns()).rejects.toThrow("database unavailable");
      failing = false;
      const error: unknown = await storage.stopRun("nope", 1).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ code: "not-found" });
    } finally {
      dispose();
    }
  });
});
