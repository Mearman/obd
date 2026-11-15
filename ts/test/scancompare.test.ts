import { describe, expect, it } from "vitest";
import { ScanFileError, compareScans, parseScan, renderComparison } from "../src/core/index.js";
import { scan, scanText, unit } from "./support/scans.js";

describe("compareScans", () => {
  it("finds codes that appeared, cleared and changed", () => {
    const first = scan("a.json", [
      unit("esp", {
        faults: [
          ["5123", "61"],
          ["9003", "20"],
          ["1111", "08"],
        ],
      }),
    ]);
    const second = scan("b.json", [
      unit("esp", {
        faults: [
          ["5123", "21"],
          ["1111", "08"],
          ["2222", "40"],
        ],
      }),
    ]);
    const [change, ...rest] = compareScans(first, second);
    expect(rest).toEqual([]);
    expect(change?.appeared).toEqual(["2222 (status 40)"]);
    expect(change?.cleared).toEqual(["9003 (status 20)"]);
    expect(change?.changed).toEqual(["5123: status 61 -> 21"]);
  });

  it("finds units that start and stop answering or are missing", () => {
    const first = scan("a.json", [
      unit("engine", { answered: false }),
      unit("esp", { faults: [] }),
      unit("gone", { faults: [] }),
    ]);
    const second = scan("b.json", [
      unit("engine", { faults: [] }),
      unit("esp", { answered: false }),
      unit("new", { faults: [] }),
    ]);
    const changes = new Map(compareScans(first, second).map((change) => [change.unit, change]));
    expect(changes.get("engine")?.answering).toBe("started answering");
    expect(changes.get("esp")?.answering).toBe("stopped answering");
    expect(changes.get("gone")?.presence).toBe("only in the first scan");
    expect(changes.get("new")?.presence).toBe("only in the second scan");
  });

  it("orders units as in the first scan, then those only in the second", () => {
    const first = scan("a.json", [unit("b", { faults: [] }), unit("a", { faults: [] })]);
    const second = scan("b.json", [unit("c", { faults: [] }), unit("a", { faults: [] })]);
    expect(compareScans(first, second).map((change) => change.unit)).toEqual(["b", "c"]);
  });

  it("finds identical scans identical", () => {
    const same = scan("a.json", [unit("esp", { faults: [["5123", "61"]], ident: { part: "AA" } })]);
    expect(compareScans(same, same)).toEqual([]);
  });

  it("does not compare codes when one scan did not read them", () => {
    const first = scan("a.json", [unit("esp", { faults: null })]);
    const second = scan("b.json", [unit("esp", { faults: [["5123", "61"]] })]);
    const [change] = compareScans(first, second);
    expect(change?.faultsNote).toBe("fault codes were not read in the first scan");
    expect(change?.appeared).toEqual([]);
  });

  it("notes codes that neither scan read for an answering unit", () => {
    const first = scan("a.json", [unit("esp")]);
    const second = scan("b.json", [unit("esp")]);
    expect(compareScans(first, second)[0]?.faultsNote).toBe(
      "fault codes were not read in either scan",
    );
  });

  it("finds freeze frame and identification changes", () => {
    const first = scan("a.json", [
      unit("esp", { faults: [["5123", "61"]], frames: { "5123": "01" }, ident: { part: "AA" } }),
    ]);
    const second = scan("b.json", [
      unit("esp", { faults: [["5123", "61"]], frames: { "5123": "02" }, ident: { part: "BB" } }),
    ]);
    const [change] = compareScans(first, second);
    expect(change?.freezeChanged).toEqual(["5123: 01 -> 02"]);
    expect(change?.identificationChanged).toEqual(["part: AA -> BB"]);
  });

  it("compares a repeated code by all its statuses", () => {
    const parsed = scan("x.json", [
      unit("esp", {
        faults: [
          ["5123", "61"],
          ["5123", "20"],
        ],
      }),
    ]);
    expect(parsed.units.get("esp")?.faults).toEqual(new Map([["5123", ["20", "61"]]]));
  });
});

describe("parseScan", () => {
  it.each([
    ["text that is not JSON", "not json"],
    ["an array", "[]"],
    ["another tool's file", '{"tool": "other"}'],
    ["units that are not a list", '{"tool": "obd-read", "units": 3}'],
    ["a unit that appears twice", scanText([unit("esp"), unit("esp")])],
    ["an answered flag that is not a boolean", scanText([{ ...unit("esp"), answered: "yes" }])],
  ])("refuses %s", (_label, text) => {
    expect(() => parseScan(text, "x.json")).toThrow(ScanFileError);
  });

  it("names the file in the error", () => {
    expect(() => parseScan("[]", "x.json")).toThrow(/^x\.json: /);
  });
});

describe("renderComparison", () => {
  it("prints the header and the changes", () => {
    const first = scan("a.json", [unit("esp", { faults: [["9003", "20"]] })]);
    const second = scan("b.json", [unit("esp", { faults: [] })]);
    expect(renderComparison(first, second, compareScans(first, second))).toEqual([
      "first scan:  a.json (taken 2026-01-01T00:00:00+00:00, profile test)",
      "second scan: b.json (taken 2026-01-01T00:00:00+00:00, profile test)",
      "esp:",
      "  cleared: 9003 (status 20)",
    ]);
  });

  it("says when there are no differences", () => {
    const same = scan("a.json", [unit("esp", { faults: [] })]);
    expect(renderComparison(same, same, []).at(-1)).toBe("no differences");
  });
});
