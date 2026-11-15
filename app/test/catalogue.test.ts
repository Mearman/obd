import { builtinProfiles } from "obd-read/profiles";
import { describe, expect, it } from "vitest";
import {
  groupOf,
  grouped,
  importedEntry,
  matches,
  shippedEntry,
  splitDescription,
} from "../src/profiles/catalogue";

describe("catalogue", () => {
  it("puts every shipped profile in a named make group", () => {
    for (const name of builtinProfiles()) expect(groupOf(name)).not.toBe("Other");
  });

  it("splits a description at its first comma", () => {
    expect(splitDescription("Mercedes-Benz E-Class, chassis 211")).toEqual({
      title: "Mercedes-Benz E-Class",
      detail: "chassis 211",
    });
    expect(splitDescription("No comma")).toEqual({ title: "No comma", detail: "" });
  });

  it("finds a profile by chassis, make or a mix, and by nothing else", () => {
    const entry = shippedEntry("mercedes-w211");
    expect(matches(entry, "")).toBe(true);
    expect(matches(entry, "e-class mercedes")).toBe(true);
    expect(matches(entry, "w211")).toBe(true);
    expect(matches(entry, "toyota")).toBe(false);
  });

  it("sorts groups and keeps imported profiles last", () => {
    const result = grouped([
      importedEntry("mine"),
      shippedEntry("vag-mqb"),
      shippedEntry("bmw-i3"),
    ]);
    expect(result.map((g) => g.group)).toEqual(["BMW", "Volkswagen Group", "Imported"]);
  });
});
