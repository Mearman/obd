import type { PlanClock } from "../../src/core/index.js";

/** A clock that only moves when the runner sleeps, so a plan of minutes runs at once. `minimumStepMs` is the least a sleep moves it, standing in for the time a real adapter takes to answer a request. */
export class FakeClock implements PlanClock {
  constructor(
    public time = 1_700_000_000_000,
    private readonly minimumStepMs = 1,
  ) {}

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number): Promise<void> {
    // A fastest phase sleeps for nothing; the minimum step keeps the fake time moving.
    this.time += Math.max(this.minimumStepMs, milliseconds);
    return Promise.resolve();
  }
}
