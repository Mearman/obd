import { describe, expect, it, vi } from "vitest";
import { holdDatabaseLock, readLockStatus, type ExclusiveLocks } from "../src/database/exclusive";
import { FakeLocks } from "./fake-tabs";

describe("holdDatabaseLock", () => {
  it("takes a free lock without queueing", async () => {
    const queued = vi.fn();
    await holdDatabaseLock(new FakeLocks().for("first"), "db", queued);
    expect(queued).not.toHaveBeenCalled();
  });

  it("queues behind the holder and takes the lock once the holder goes away", async () => {
    const locks = new FakeLocks();
    await holdDatabaseLock(locks.for("first"), "db", () => undefined);
    const queued = vi.fn();
    let held = false;
    const second = holdDatabaseLock(locks.for("second"), "db", queued).then(() => {
      held = true;
    });
    await vi.waitFor(() => {
      expect(queued).toHaveBeenCalledOnce();
    });
    expect(held).toBe(false);
    expect(locks.holder("db")).toBe("first");

    locks.release("first");
    await second;
    expect(locks.holder("db")).toBe("second");
  });

  it("grants waiters in the order they asked", async () => {
    const locks = new FakeLocks();
    await holdDatabaseLock(locks.for("first"), "db", () => undefined);
    const order: string[] = [];
    const second = holdDatabaseLock(locks.for("second"), "db", () => undefined).then(() => {
      order.push("second");
    });
    const third = holdDatabaseLock(locks.for("third"), "db", () => undefined).then(() => {
      order.push("third");
    });
    await Promise.resolve();
    locks.release("first");
    await second;
    locks.release("second");
    await third;
    expect(order).toEqual(["second", "third"]);
  });

  it("locks each name separately", async () => {
    const locks = new FakeLocks();
    await holdDatabaseLock(locks.for("first"), "a", () => undefined);
    const queued = vi.fn();
    await holdDatabaseLock(locks.for("second"), "b", queued);
    expect(queued).not.toHaveBeenCalled();
  });

  it("rejects when the lock manager itself fails", async () => {
    const failing: ExclusiveLocks = { request: () => Promise.reject(new Error("denied")) };
    await expect(holdDatabaseLock(failing, "db", () => undefined)).rejects.toThrow("denied");
  });
});

describe("readLockStatus", () => {
  it("reads the worker's lock reports and ignores other messages", () => {
    expect(readLockStatus({ kind: "database-lock", state: "queued" })).toEqual({
      kind: "database-lock",
      state: "queued",
    });
    expect(readLockStatus({ kind: "database-lock", state: "failed", message: "no" })).toEqual({
      kind: "database-lock",
      state: "failed",
      message: "no",
    });
    expect(readLockStatus({ kind: "database-lock", state: "failed" })).toBeUndefined();
    expect(readLockStatus({ kind: "sql-response", id: 1 })).toBeUndefined();
    expect(readLockStatus(null)).toBeUndefined();
  });
});
