import { describe, expect, it } from "vitest";
import { jsonText, pythonRepr, type JsonValue } from "../src/core/index.js";

describe("pythonRepr", () => {
  it.each([
    ["radio", "'radio'"],
    ["it's", '"it\'s"'],
    ['say "hi"', "'say \"hi\"'"],
    ["both ' and \"", "'both \\' and \"'"],
    ["back\\slash", "'back\\\\slash'"],
    ["line\nbreak\ttab\rreturn", "'line\\nbreak\\ttab\\rreturn'"],
    ["bell\u0007", "'bell\\x07'"],
    ["café", "'café'"],
  ])("formats %j as Python's repr does", (text, expected) => {
    expect(pythonRepr(text)).toBe(expected);
  });
});

describe("jsonText", () => {
  it("keeps the order of a Map's keys even when they look like integers", () => {
    expect(
      jsonText(
        new Map([
          ["9003", "b"],
          ["5123", "a"],
        ]),
      ),
    ).toBe('{\n  "9003": "b",\n  "5123": "a"\n}');
  });

  it("writes empty containers inline, as Python does", () => {
    const value = new Map<string, JsonValue>([
      ["a", []],
      ["b", new Map<string, JsonValue>()],
    ]);
    expect(jsonText(value)).toBe('{\n  "a": [],\n  "b": {}\n}');
  });

  it("escapes what Python's ensure_ascii escapes", () => {
    expect(jsonText('q"\\\n\u007fé😀')).toBe('"q\\"\\\\\\n\\u007f\\u00e9\\ud83d\\ude00"');
  });

  it("refuses a number that is not whole", () => {
    expect(() => jsonText(1.5)).toThrow(RangeError);
  });
});
