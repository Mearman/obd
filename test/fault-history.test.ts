import { describe, expect, it } from "vitest";
import {
  FAULT_SIGNALS,
  NO_CODES,
  faultEvents,
  faultListOf,
  faultSampleValue,
  parseFaultValue,
  type Sample,
} from "../src/core/index.js";

function sample(list: keyof typeof FAULT_SIGNALS, timestamp: number, value: string): Sample {
  return { runId: "r", signal: FAULT_SIGNALS[list], unit: "", timestamp, value };
}

describe("fault sample values", () => {
  it("sorts, de-duplicates and names an empty list", () => {
    expect(faultSampleValue(["P0420", "P0302", "P0420"])).toBe("P0302 P0420");
    expect(faultSampleValue([])).toBe(NO_CODES);
  });

  it("reads a value back into its codes", () => {
    expect(parseFaultValue("P0302 P0420")).toEqual(["P0302", "P0420"]);
    expect(parseFaultValue(NO_CODES)).toEqual([]);
  });

  it("names the list a signal records and no other", () => {
    expect(faultListOf("pending fault codes")).toBe("pending");
    expect(faultListOf("engine speed")).toBeUndefined();
  });
});

describe("faultEvents", () => {
  it("marks codes present at the first poll as there from the start", () => {
    expect(faultEvents([sample("stored", 10, "P0302")])).toEqual([
      { timestamp: 10, list: "stored", code: "P0302", change: "appeared", atStart: true },
    ]);
  });

  it("reports nothing for a list that starts empty", () => {
    expect(faultEvents([sample("stored", 10, NO_CODES)])).toEqual([]);
  });

  it("reports a code that appears and one that goes, each at the poll that saw it", () => {
    const events = faultEvents([
      sample("pending", 10, NO_CODES),
      sample("pending", 20, "P0171"),
      sample("pending", 30, "P0171 P0302"),
      sample("pending", 40, NO_CODES),
    ]);
    expect(events.map((e) => [e.timestamp, e.code, e.change, e.atStart])).toEqual([
      [20, "P0171", "appeared", false],
      [30, "P0302", "appeared", false],
      [40, "P0171", "disappeared", false],
      [40, "P0302", "disappeared", false],
    ]);
  });

  it("tracks each list on its own and ignores other signals and numbers", () => {
    const events = faultEvents([
      sample("stored", 10, "P0302"),
      sample("pending", 10, "P0302"),
      { runId: "r", signal: "engine speed", unit: "rpm", timestamp: 12, value: 800 },
      sample("pending", 20, NO_CODES),
    ]);
    expect(events.map((e) => `${e.list} ${e.change} ${String(e.timestamp)}`)).toEqual([
      "stored appeared 10",
      "pending appeared 10",
      "pending disappeared 20",
    ]);
  });
});
