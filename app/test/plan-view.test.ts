import type { PlanEventData } from "obd-read";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, codesAtEnds, formatMoment, planView } from "../src/guide/plan-view";

const START = 1_700_000_000_000;

describe("the Guide screen's view of a plan", () => {
  it("lists codes that appear and clear with their times, and the codes at each end", () => {
    const codes = (at: number, found: string[]): PlanEventData => ({
      type: "read",
      at,
      phase: "drive",
      record: {
        read: "pending-codes",
        when: "end",
        at,
        result: { kind: "codes", list: "pending", units: [{ unit: "7E8", codes: found }] },
      },
    });
    const events: PlanEventData[] = [
      codes(START, []),
      { type: "code-appeared", at: START + 12_000, phase: "drive", list: "pending", code: "P0300" },
      { type: "code-cleared", at: START + 75_000, phase: "drive", list: "pending", code: "P0300" },
      codes(START + 80_000, ["P0171"]),
    ];
    const view = events.reduce(planView, { ...EMPTY_VIEW, startedAt: START });
    expect(view.notices.map((notice) => notice.text)).toEqual([
      "P0300 appeared in the pending codes.",
      "P0300 cleared from the pending codes.",
    ]);
    expect(formatMoment(START + 75_000, START)).toBe("22:14:35 UTC (+1 min 15 s)");
    expect(codesAtEnds(view.reads)).toEqual([{ list: "pending", start: [], end: ["P0171 (7E8)"] }]);
  });
});
