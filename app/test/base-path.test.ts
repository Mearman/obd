import { describe, expect, it } from "vitest";
import { basePathFrom } from "../base-path";

describe("basePathFrom", () => {
  it.each([
    [undefined, "/"],
    ["", "/"],
    ["/", "/"],
    ["obd", "/obd/"],
    ["/obd", "/obd/"],
    ["/obd/", "/obd/"],
    ["//obd//", "/obd/"],
    ["/a/b", "/a/b/"],
  ])("normalises %j to %j", (value, expected) => {
    expect(basePathFrom({ BASE_PATH: value })).toBe(expected);
  });

  it("is the root when the variable is absent", () => {
    expect(basePathFrom({})).toBe("/");
  });
});
