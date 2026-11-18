import { describe, expect, it, vi } from "vitest";
import { WorkBudgetExceeded, budgetEach, withinBudget, type WorkBudget } from "./work-budget";

const BUDGET: WorkBudget = { processorMs: 200, sampleMs: 10, idleSamples: 20, idleProcessorMs: 1 };

/** Keeps the processor busy for `ms` of elapsed time, then lets the event loop turn. */
async function spin(ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Busy on purpose: this is the work being measured.
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A test that keeps the processor busy until `live` is no longer active. It stops by itself well past the budget, so a budget that never trips fails the test using it instead of leaving it running. */
function busyPast(live: { readonly active: boolean }): () => Promise<void> {
  return async () => {
    const started = process.cpuUsage();
    const used = () => {
      const { user, system } = process.cpuUsage(started);
      return (user + system) / 1000;
    };
    while (live.active && used() < BUDGET.processorMs * 5) await spin(5);
  };
}

describe("a work budget", () => {
  it("lets a test that stays inside it settle as the test does", async () => {
    await expect(
      withinBudget(
        () => spin(5),
        BUDGET,
        () => "",
      ),
    ).resolves.toBeUndefined();
    await expect(
      withinBudget(
        () => Promise.reject(new Error("the test's own failure")),
        BUDGET,
        () => "",
      ),
    ).rejects.toThrow("the test's own failure");
  });

  it("fails a test that keeps the processor busy past the budget", async () => {
    const live = { active: true };
    await expect(withinBudget(busyPast(live), BUDGET, () => "the busy page")).rejects.toThrow(
      /more than its 200 ms of processor time[^]*the busy page/,
    );
    live.active = false;
  });

  it("fails a test waiting on something that never happens", async () => {
    await expect(
      withinBudget(
        () => new Promise(() => undefined),
        BUDGET,
        () => "the idle page",
      ),
    ).rejects.toThrow(/did no work for 21 samples in a row[^]*the idle page/);
  });

  it("allows idle stretches shorter than the idle limit, however many there are", async () => {
    const pauses = async () => {
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, (BUDGET.sampleMs * BUDGET.idleSamples) / 2),
        );
        await spin(BUDGET.sampleMs * 2);
      }
    };
    await expect(withinBudget(pauses, BUDGET, () => "")).resolves.toBeUndefined();
  });
});

describe("a worker's tests under one work budget", () => {
  it("fails every later test without running it once one reaches the budget, naming that one", async () => {
    const each = budgetEach(BUDGET, () => "");
    const live = { active: true };
    await expect(each(busyPast(live), "the busy test")).rejects.toThrow(WorkBudgetExceeded);
    live.active = false;
    const later = vi.fn(() => Promise.resolve());
    await expect(each(later, "a later test")).rejects.toThrow(
      /^Not run: "the busy test" reached its work budget/,
    );
    expect(later).not.toHaveBeenCalled();
  });

  it("runs the later tests after one fails of its own accord", async () => {
    const each = budgetEach(BUDGET, () => "");
    await expect(
      each(() => Promise.reject(new Error("the test's own failure")), "the failing test"),
    ).rejects.toThrow("the test's own failure");
    const later = vi.fn(() => Promise.resolve());
    await expect(each(later, "a later test")).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledOnce();
  });
});
