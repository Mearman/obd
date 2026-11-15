import { describe, expect, it } from "vitest";
import { runClaims, runLockName } from "../src/diagnostics/run-claims";
import { FakeLocks } from "./fake-tabs";

describe("runClaims", () => {
  it("lets one tab claim a run, refuses another while it holds it, and frees it on release", async () => {
    const locks = new FakeLocks();
    const first = runClaims(locks.for("first"));
    const second = runClaims(locks.for("second"));

    expect(await first.claim("run-1")).toBe(true);
    expect(await first.claim("run-1")).toBe(true);
    expect(await second.claim("run-1")).toBe(false);
    expect(await second.claim("run-2")).toBe(true);

    first.release("run-1");
    await Promise.resolve();
    expect(locks.holder(runLockName("run-1"))).toBeUndefined();
    expect(await second.claim("run-1")).toBe(true);
  });

  it("frees a run when the tab holding it goes away", async () => {
    const locks = new FakeLocks();
    expect(await runClaims(locks.for("closed")).claim("run-1")).toBe(true);
    locks.release("closed");
    expect(await runClaims(locks.for("reloaded")).claim("run-1")).toBe(true);
  });

  it("claims every run when the browser has no lock manager", async () => {
    const claims = runClaims(undefined);
    expect(await claims.claim("run-1")).toBe(true);
  });
});
