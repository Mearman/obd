import { describe, expect, it } from "vitest";
import {
  checkProfile,
  parseProfile,
  profilesForVin,
  vinMatch,
  type Profile,
} from "../src/core/index.js";
import { builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { MINIMAL, edit } from "./support/profiles.js";

const HINT = { wmi: ["XYZ", "XY1"], models: ["123", "45"], source: "made up for the test" };

function profileWith(name: string, vin: unknown): Profile {
  return parseProfile(edit(edit(MINIMAL, ["name"], name), ["vin"], vin), name);
}

describe("the vin hint of a profile", () => {
  it("is optional and loads into the profile", () => {
    expect(parseProfile(MINIMAL, "test").vin).toBeUndefined();
    expect(profileWith("hinted", HINT).vin).toEqual({ wmi: ["XYZ", "XY1"], models: ["123", "45"] });
    expect(profileWith("maker-only", { wmi: ["XYZ"], source: "s" }).vin).toEqual({
      wmi: ["XYZ"],
      models: [],
    });
  });

  it("passes the check when well formed", () => {
    expect(checkProfile(edit(MINIMAL, ["vin"], HINT), "test")).toEqual([]);
  });

  it.each([
    ["no WMI", { ...HINT, wmi: [] }, /\[vin\]: wmi must list/],
    ["a WMI of two characters", { ...HINT, wmi: ["XY"] }, /wmi .* must be 3 VIN characters/],
    ["a lower-case WMI", { ...HINT, wmi: ["xyz"] }, /wmi .* must be 3 VIN characters/],
    [
      "a WMI with a letter a VIN never holds",
      { ...HINT, wmi: ["XYO"] },
      /wmi .* must be 3 VIN characters/,
    ],
    ["a repeated WMI", { ...HINT, wmi: ["XYZ", "XYZ"] }, /wmi XYZ is listed twice/],
    ["an empty model", { ...HINT, models: [""] }, /model .* must be 1 to 6 VIN characters/],
    [
      "a model of seven characters",
      { ...HINT, models: ["1234567"] },
      /model .* must be 1 to 6 VIN characters/,
    ],
    ["a repeated model", { ...HINT, models: ["123", "123"] }, /model 123 is listed twice/],
    ["no source", { wmi: ["XYZ"] }, /\[vin\]: missing source/],
  ])("is rejected with %s", (_what, vin, problem) => {
    const problems = checkProfile(edit(MINIMAL, ["vin"], vin), "test");
    expect(problems.join("\n")).toMatch(problem);
  });

  it("is rejected with a blank source or an unknown key", () => {
    expect(checkProfile(edit(MINIMAL, ["vin"], { ...HINT, source: " " }), "test")).toEqual([
      "[vin]: source is blank, so the identifiers cannot be traced",
    ]);
    expect(checkProfile(edit(MINIMAL, ["vin"], { ...HINT, year: 2005 }), "test")).toEqual([
      expect.stringMatching(/\[vin\].*year/),
    ]);
  });
});

describe("vinMatch", () => {
  const hinted = profileWith("hinted", HINT);
  const makerOnly = profileWith("maker-only", { wmi: ["XYZ"], source: "s" });
  const none = parseProfile(MINIMAL, "test");

  it("matches the model when the VIN's descriptor starts with a listed model", () => {
    expect(vinMatch(hinted, "XYZ12300000000000")).toBe("model");
    expect(vinMatch(hinted, "XY145000000000000")).toBe("model");
  });

  it("does not match a profile whose models the VIN's descriptor does not start with", () => {
    expect(vinMatch(hinted, "XYZ99900000000000")).toBeUndefined();
  });

  it("matches the maker alone when the profile lists no models", () => {
    expect(vinMatch(makerOnly, "XYZ99900000000000")).toBe("maker");
  });

  it("never matches another maker, a profile with no hint or a string that is not a VIN", () => {
    expect(vinMatch(hinted, "ABC12300000000000")).toBeUndefined();
    expect(vinMatch(none, "XYZ12300000000000")).toBeUndefined();
    expect(vinMatch(makerOnly, "XYZ123")).toBeUndefined();
    expect(vinMatch(makerOnly, "XYZ1230000000000O")).toBeUndefined();
  });

  it("reads a VIN in lower case or with surrounding space as the VIN", () => {
    expect(vinMatch(hinted, " xyz12300000000000 ")).toBe("model");
  });
});

describe("profilesForVin", () => {
  it("lists model matches before maker matches, each by name", () => {
    const profiles = [
      profileWith("b-maker", { wmi: ["XYZ"], source: "s" }),
      profileWith("z-model", HINT),
      profileWith("a-model", HINT),
      profileWith("other", { wmi: ["ABC"], source: "s" }),
      parseProfile(MINIMAL, "test"),
    ];
    expect(
      profilesForVin("XYZ12300000000000", profiles).map(({ profile, match }) => [
        profile.name,
        match,
      ]),
    ).toEqual([
      ["a-model", "model"],
      ["z-model", "model"],
      ["b-maker", "maker"],
    ]);
  });
});

describe("the shipped profiles' vin hints", () => {
  const shipped = builtinProfiles().map(loadBuiltinProfile);

  it.each(builtinProfiles())("%s names its makers", (name) => {
    expect(loadBuiltinProfile(name).vin?.wmi.length).toBeGreaterThan(0);
  });

  // Synthetic VINs in the rest-of-world form: the WMI, then the chassis series as characters 4 to 6.
  it.each([
    ["WDD2110000A000000", "mercedes-w211"],
    ["WDB1690000J000000", "mercedes-w169-w245"],
    ["WDD2460000J000000", "mercedes-mfa"],
    ["WDD2120000A000000", "mercedes-w204-w212"],
  ])("offers only the matching Mercedes profile for %s", (vin, profile) => {
    const offered = profilesForVin(vin, shipped);
    expect(offered.map((entry) => entry.profile.name)).toEqual([profile]);
    expect(offered[0]?.match).toBe("model");
  });
});
