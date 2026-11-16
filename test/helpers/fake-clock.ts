import type { PlanClock } from "../../src/core/index.js";

/** A clock that only moves when the runner sleeps, so a plan of minutes runs at once. */
export class FakeClock implements PlanClock {
  constructor(public time = 1_700_000_000_000) {}

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number): Promise<void> {
    // A fastest phase sleeps for nothing; a millisecond keeps the fake time moving.
    this.time += Math.max(1, milliseconds);
    return Promise.resolve();
  }
}
