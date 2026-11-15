import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatOutput, readVersion, releaseDecision } from "../scripts/release-needed.ts";

describe("releaseDecision", () => {
  it("needs a release when the tag is absent", () => {
    expect(releaseDecision("0.1.0", [])).toEqual({ version: "0.1.0", tag: "v0.1.0", needed: true });
    expect(releaseDecision("0.2.0", ["v0.1.0"]).needed).toBe(true);
  });

  it("needs nothing when the tag exists", () => {
    expect(releaseDecision("0.1.0", ["v0.0.9", "v0.1.0"]).needed).toBe(false);
  });

  it("matches the whole tag name, not a prefix or an untagged number", () => {
    expect(releaseDecision("0.1.0", ["v0.1.0-rc.1", "v0.1.01", "0.1.0"]).needed).toBe(true);
    expect(releaseDecision("0.1.0-rc.1", ["v0.1.0"]).needed).toBe(true);
  });
});

describe("readVersion", () => {
  it("reads the version field", () => {
    expect(readVersion('{"name":"x","version":"1.2.3"}')).toBe("1.2.3");
    expect(readVersion('{"version":"1.2.3-rc.1"}')).toBe("1.2.3-rc.1");
  });

  it.each(["{}", "[]", "null", '{"version":1}', '{"version":"1.2"}', '{"version":"v1.2.3"}'])(
    "rejects %s",
    (text) => {
      expect(() => readVersion(text)).toThrow();
    },
  );
});

describe("formatOutput", () => {
  it("writes one key=value line per field", () => {
    expect(formatOutput(releaseDecision("0.1.0", []))).toBe(
      "version=0.1.0\ntag=v0.1.0\nneeded=true\n",
    );
  });
});

describe("the repository's versions", () => {
  it("is the same in the package and in the app", () => {
    const root = readVersion(readFileSync("package.json", "utf8"));
    const app = readVersion(readFileSync("app/package.json", "utf8"));
    expect(app).toBe(root);
  });
});
