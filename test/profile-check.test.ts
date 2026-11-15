import { describe, expect, it } from "vitest";
import { checkProfile, checkProfileText, profileCheckReport } from "../src/core/index.js";
import { builtinProfileData, builtinProfiles } from "../src/profiles/index.js";
import { CODES_PROFILE, KLINE_PROFILE, KWP_PROFILE, MINIMAL, edit } from "./support/profiles.js";

describe("checkProfile", () => {
  it.each(builtinProfiles())("shipped profile %s passes the check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it("finds a sound profile sound", () => {
    expect(checkProfile(MINIMAL, "test")).toEqual([]);
    expect(checkProfile(CODES_PROFILE, "test")).toEqual([]);
    expect(checkProfile(KLINE_PROFILE, "test")).toEqual([]);
  });

  it("accepts named values", () => {
    expect(checkProfile(KWP_PROFILE, "test")).toEqual([]);
  });

  it.each([
    [
      "a session the guard does not allow",
      edit(MINIMAL, ["diagnostics", "session"], 0x02),
      /not a read-only session/,
    ],
    ["a status that is not a status", edit(MINIMAL, ["status"], "probably"), /status must be/],
    [
      "a name that is not hyphenated words",
      edit(MINIMAL, ["name"], "Test Car"),
      /lower-case words/,
    ],
    [
      "a request wider than the bus",
      edit(MINIMAL, ["units", "engine", "request"], 0x800),
      /does not fit 11-bit/,
    ],
    [
      "a request equal to its response",
      edit(MINIMAL, ["units", "engine", "request"], 0x7e8),
      /request and response are both 0x7e8/,
    ],
    ["a blank source", edit(MINIMAL, ["units", "engine", "source"], "  "), /source is blank/],
    [
      "a blank description",
      edit(MINIMAL, ["units", "engine", "description"], ""),
      /description is blank/,
    ],
    ["a blank profile description", edit(MINIMAL, ["description"], " "), /^description is blank/],
    ["a misspelt bus key", edit(MINIMAL, ["bus", "bit_rate"], 1), /^\[bus\]: unknown key bit_rate/],
    [
      "a stray unit key",
      edit(MINIMAL, ["units", "engine", "note"], "stray"),
      /^\[units\.engine\]: unknown key note/,
    ],
    ["a stray profile key", edit(MINIMAL, ["extra"], 1), /^profile: unknown key extra/],
    [
      "a stray diagnostics key",
      edit(MINIMAL, ["diagnostics", "extra"], 1),
      /^\[diagnostics\]: unknown key extra/,
    ],
    [
      "a stray key in a unit's diagnostics",
      edit(MINIMAL, ["units", "engine", "diagnostics"], {
        protocol: "uds",
        session: 1,
        extra: 1,
      }),
      /^\[units\.engine\.diagnostics\]: unknown key extra/,
    ],
    [
      "a misspelt value key",
      edit(KWP_PROFILE, ["units", "engine", "values", "boost", "scal"], 0.1),
      /^\[units\.engine\.values\.boost\]: unknown key scal/,
    ],
    [
      "a value status that is not a status",
      edit(KWP_PROFILE, ["units", "engine", "values", "boost", "status"], "maybe"),
      /values\.boost\]: status must be/,
    ],
    [
      "a value with a blank source",
      edit(KWP_PROFILE, ["units", "engine", "values", "boost", "source"], ""),
      /values\.boost\]: source is blank/,
    ],
    [
      "a value with a zero scale",
      edit(KWP_PROFILE, ["units", "engine", "values", "boost", "scale"], 0),
      /values\.boost\]: scale is zero/,
    ],
    [
      "a K-line address wider than a byte",
      edit(KLINE_PROFILE, ["units", "abs", "request"], 0x128),
      /does not fit one-byte/,
    ],
    [
      "a code table for a unit the profile lacks",
      edit(CODES_PROFILE, ["codes", "radio"], { "5123": { text: "x", source: "y" } }),
      /\[codes\.radio\]: names a unit the profile does not define/,
    ],
    [
      "a code that is not hexadecimal",
      edit(CODES_PROFILE, ["codes", "esp", "zz"], { text: "x", source: "y" }),
      /codes\.esp\.zz\]: .*neither an SAE code/,
    ],
  ])("reports %s", (_label, data, message) => {
    const problems = checkProfile(data, "test");
    expect(problems.some((problem) => message.test(problem))).toBe(true);
  });

  it("reports an identifier shared by two units", () => {
    const extra = edit(MINIMAL, ["units", "gearbox"], {
      description: "G",
      request: 0x7e0,
      response: 0x7e9,
      source: "s",
    });
    expect(checkProfile(extra, "test")).toEqual([
      "[units.gearbox]: request 0x7e0 is also used by engine",
    ]);
  });

  it("reports every load failure with where it is", () => {
    const data = edit(
      edit(MINIMAL, ["status"], undefined),
      ["units", "engine", "response"],
      undefined,
    );
    expect(checkProfile(data, "car.json")).toEqual([
      "car.json: missing status",
      "car.json [units.engine]: missing response",
    ]);
  });

  it("treats text that is not JSON as one problem", () => {
    expect(checkProfileText("{", "test")).toHaveLength(1);
  });

  it("checks a profile given as JSON text", () => {
    expect(checkProfileText(JSON.stringify(MINIMAL), "test")).toEqual([]);
  });
});

describe("profileCheckReport", () => {
  it("says ok for a sound profile", () => {
    expect(profileCheckReport("mercedes-w211", [])).toEqual(["mercedes-w211: ok"]);
  });

  it("counts and indents the problems", () => {
    expect(profileCheckReport("bad.json", ["a"])).toEqual(["bad.json: 1 problem", "  a"]);
    expect(profileCheckReport("bad.json", ["a", "b"])).toEqual([
      "bad.json: 2 problems",
      "  a",
      "  b",
    ]);
  });
});
