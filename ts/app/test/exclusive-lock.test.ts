import { DatabaseUnavailableError } from "obd-read/web/storage";
import { describe, expect, it } from "vitest";
import { holdExclusiveLock, type ExclusiveLocks } from "../src/database/exclusive";

/** A lock manager that grants each name once and never releases it, as a live tab does. */
function lockManager(): ExclusiveLocks {
  const held = new Set<string>();
  return {
    request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      return callback({});
    },
  };
}

describe("holdExclusiveLock", () => {
  it("resolves for the first holder and rejects the second with an in-use error", async () => {
    const locks = lockManager();
    await holdExclusiveLock(locks, "db");
    const second = holdExclusiveLock(locks, "db");
    await expect(second).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(second).rejects.toMatchObject({ reason: "in-use" });
  });

  it("locks each name separately", async () => {
    const locks = lockManager();
    await holdExclusiveLock(locks, "a");
    await expect(holdExclusiveLock(locks, "b")).resolves.toBeUndefined();
  });

  it("rejects when the lock manager itself fails", async () => {
    const failing: ExclusiveLocks = { request: () => Promise.reject(new Error("denied")) };
    await expect(holdExclusiveLock(failing, "db")).rejects.toThrow("denied");
  });
});
