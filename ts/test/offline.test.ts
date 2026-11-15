import { describe, expect, it } from "vitest";
import {
  CodeNameError,
  CodeNames,
  DefinitionError,
  ScanFileError,
  compareReport,
  describeCode,
  describeRequests,
  describeScan,
  importNames,
  offlineErrorLine,
  parseNamesFile,
  parseProfileCodes,
  wroteLine,
} from "../src/core/index.js";
import { loadGenericTitles } from "../src/data/index.js";
import { ODX } from "./support/odx.js";
import { CODES_PROFILE } from "./support/profiles.js";
import { scan, unit } from "./support/scans.js";

const names = (...imported: ReturnType<typeof parseNamesFile>[]): CodeNames =>
  new CodeNames(loadGenericTitles(), parseProfileCodes(CODES_PROFILE, "car.json"), imported);

describe("compare", () => {
  it("prints the changes", () => {
    const first = scan("a.json", [unit("esp", { faults: [["9003", "20"]] })]);
    const second = scan("b.json", [unit("esp", { faults: [] })]);
    const lines = compareReport(first, second);
    expect(lines).toContain("esp:");
    expect(lines).toContain("  cleared: 9003 (status 20)");
  });
});

describe("describe", () => {
  it("names a generic code", () => {
    expect(describeCode("p0420", undefined, names())).toMatch(
      /^P0420: Catalyst System Efficiency Below Threshold Bank 1 {2}\[OBDex/,
    );
  });

  it("names the codes of a scan and says when it cannot", () => {
    const saved = scan("scan.json", [
      unit("esp", {
        faults: [
          ["5123", "61"],
          ["9003", "20"],
        ],
      }),
      unit("engine"),
    ]);
    expect(describeScan(saved, names())).toEqual([
      "scan.json (taken 2026-01-01T00:00:00+00:00, profile test)",
      "  esp 5123 status 61: Wheel speed sensor, front left  [invented for the test]",
      "  esp 9003 status 20: no description known",
    ]);
  });

  it("looks a hexadecimal code up only in a unit's table", () => {
    expect(describeCode("5123", "esp", names())).toBe(
      "esp 5123: Wheel speed sensor, front left  [invented for the test]",
    );
    expect(describeCode("5123", undefined, names())).toBe("5123: no description known");
  });

  it("refuses an item that is not a code", () => {
    expect(() => describeCode("hello", undefined, names())).toThrow(CodeNameError);
  });

  it("refuses requests with no unit", () => {
    expect(() => describeRequests(["1A86"], undefined, [])).toThrow(CodeNameError);
  });
});

describe("import then describe", () => {
  it("round trips names through the saved document", () => {
    const result = importNames(new TextEncoder().encode(ODX), "test.odx-d", "esp", "TestVariantA");
    expect(result.lines).toEqual(["read 2 fault codes and 1 requests"]);
    expect(JSON.stringify(result.document)).not.toContain("/");
    expect(wroteLine("names.json", "test.odx-d")).toMatch(/must not be published$/);

    const imported = parseNamesFile(JSON.parse(JSON.stringify(result.document)), "names.json");
    const lookup = new CodeNames(new Map(), new Map(), [imported]);
    expect(describeCode("5123", "esp", lookup)).toBe(
      "esp 5123: Test sensor A fault  [imported from test.odx-d]",
    );
    expect(describeRequests(["1a 86", "FFFF"], "esp", [imported])).toEqual([
      "esp 1A86: Read test part number",
      "esp FFFF: no name known",
    ]);
  });

  it("notes conflicts before skipped entries", () => {
    const result = importNames(new TextEncoder().encode(ODX), "test.odx-d", "esp");
    expect(result.lines.slice(1)).toEqual([
      "note: fault code 5123: kept 'Test sensor A fault', ignored 'A different text'",
    ]);
  });
});

describe("offlineErrorLine", () => {
  it("reports the failures these commands own and nothing else", () => {
    expect(offlineErrorLine(new ScanFileError("x"))).toBe("error: x");
    expect(offlineErrorLine(new CodeNameError("y"))).toBe("error: y");
    expect(offlineErrorLine(new DefinitionError("z"))).toBe("error: z");
    expect(offlineErrorLine(new Error("other"))).toBeUndefined();
  });
});
