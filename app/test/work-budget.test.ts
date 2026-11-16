import { describe, expect, it } from "vitest";
import { withinBudget, type WorkBudget } from "./work-budget";

const BUDGET: WorkBudget = { processorMs: 200, sampleMs: 10, idleSamples: 20, idleProcessorMs: 1 };

/** Keeps the processor busy for `ms` of elapsed time, then lets the event loop turn. */
async function spin(ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Busy on purpose: this is the work being measured.
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    // Stops by itself well past the budget, so a budget that never trips fails this test instead of leaving it running.
    const started = process.cpuUsage();
    const busy = async () => {
      const used = () => {
        const { user, system } = process.cpuUsage(started);
        return (user + system) / 1000;
      };
      while (live.active && used() < BUDGET.processorMs * 5) await spin(5);
    };
    await expect(withinBudget(busy, BUDGET, () => "the busy page")).rejects.toThrow(
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
