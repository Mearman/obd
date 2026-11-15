import { describe, expect, it } from "vitest";
import {
  CodeNameError,
  CodeNames,
  namesDocument,
  normaliseCode,
  parseNamesFile,
  parseNamesFileText,
  parseProfileCodes,
} from "../src/core/index.js";
import { loadGenericTitles } from "../src/data/index.js";
import { CODES_PROFILE, edit } from "./support/profiles.js";

describe("generic titles", () => {
  it("cover the SAE code space", () => {
    const titles = loadGenericTitles();
    expect(titles.get("P0420")).toBe("Catalyst System Efficiency Below Threshold Bank 1");
    expect(
      [...titles.keys()].every((code) => "PBCU".includes(code[0] ?? "") && code.length === 5),
    ).toBe(true);
    expect(titles.size).toBeGreaterThan(9000);
  });
});

describe("normaliseCode", () => {
  it.each([
    ["p0420", "P0420"],
    ["5123", "5123"],
    ["51", "0051"],
    ["1", "0001"],
  ])("maps %s to one key", (raw, key) => {
    expect(normaliseCode(raw)).toBe(key);
  });

  it("refuses a code that is neither form", () => {
    expect(() => normaliseCode("hello")).toThrow(CodeNameError);
  });
});

describe("profile code tables", () => {
  it("carry their source", () => {
    expect(parseProfileCodes(CODES_PROFILE, "test")).toEqual(
      new Map([
        [
          "esp",
          new Map([
            ["5123", { text: "Wheel speed sensor, front left", source: "invented for the test" }],
          ]),
        ],
      ]),
    );
  });

  it("are empty for a profile with none", () => {
    expect(parseProfileCodes(edit(CODES_PROFILE, ["codes"], undefined), "test")).toEqual(new Map());
  });

  it.each([
    [
      "a unit the profile does not define",
      edit(CODES_PROFILE, ["codes", "radio"], { "5123": { text: "x", source: "y" } }),
    ],
    ["an entry with no source", edit(CODES_PROFILE, ["codes", "esp", "9003"], { text: "x" })],
    [
      "an entry with an empty source",
      edit(CODES_PROFILE, ["codes", "esp", "9003"], { text: "x", source: "" }),
    ],
    [
      "a code that is not hexadecimal",
      edit(CODES_PROFILE, ["codes", "esp", "zz"], { text: "x", source: "y" }),
    ],
    [
      "a code with a 0x prefix",
      edit(CODES_PROFILE, ["codes", "esp", "0x9003"], { text: "x", source: "y" }),
    ],
    [
      "two keys for one code",
      edit(CODES_PROFILE, ["codes", "esp", "05123"], { text: "x", source: "y" }),
    ],
  ])("are refused with %s", (_label, data) => {
    expect(() => parseProfileCodes(data, "test")).toThrow(CodeNameError);
  });
});

describe("names files", () => {
  const document = namesDocument(
    "defs.pdx",
    "esp",
    new Map([
      ["9003", "other"],
      ["5123", "imported"],
    ]),
    new Map(),
  );

  it("write codes in key order", () => {
    expect(Object.keys(document.units.esp?.codes ?? {})).toEqual(["5123", "9003"]);
  });

  it("the profile table wins over imported names", () => {
    const lookup = new CodeNames(new Map(), parseProfileCodes(CODES_PROFILE, "t"), [
      parseNamesFile(JSON.parse(JSON.stringify(document)), "names.json"),
    ]);
    expect(lookup.unitCode("esp", "5123")?.text).toBe("Wheel speed sensor, front left");
    expect(lookup.unitCode("esp", "9003")).toEqual({
      text: "other",
      source: "imported from defs.pdx",
    });
    expect(lookup.unitCode("esp", "1111")).toBeUndefined();
    expect(lookup.genericCode("5123")).toBeUndefined();
  });

  it("generic codes name their source", () => {
    const lookup = new CodeNames(new Map([["P0420", "Catalyst"]]), new Map(), []);
    const found = lookup.genericCode("p0420");
    expect(found?.text).toBe("Catalyst");
    expect(found?.source).toContain("OBDex");
  });

  it("must be ones the tool wrote", () => {
    expect(() => parseNamesFileText('{"kind": "scan"}', "other.json")).toThrow(CodeNameError);
    expect(() => parseNamesFileText("not json", "other.json")).toThrow(CodeNameError);
  });

  it("drop a value whose label is not text but refuse a code whose text is not", () => {
    const file = parseNamesFile(
      { kind: "names", source: "s", units: { esp: { codes: {}, values: { A: "named", B: 3 } } } },
      "n",
    );
    expect([...(file.values.get("esp") ?? [])]).toEqual([["A", "named"]]);
    expect(() =>
      parseNamesFile({ kind: "names", source: "s", units: { esp: { codes: { "5123": 3 } } } }, "n"),
    ).toThrow(CodeNameError);
  });
});
