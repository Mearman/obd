import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DefinitionError, readDefinitions } from "../src/core/index.js";
import { ODX, TRAFO } from "./support/odx.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ODX", () => {
  it("gives codes and requests", () => {
    const found = readDefinitions(bytes(ODX), "test.odx-d", "TestVariantA");
    expect(found.codes).toEqual(
      new Map([
        ["5123", "Test sensor A fault"],
        ["9003", "Test sensor B fault"],
      ]),
    );
    expect(found.values).toEqual(new Map([["1A86", "Read test part number"]]));
  });

  it("without a variant reads every layer and reports conflicts", () => {
    const found = readDefinitions(bytes(ODX), "test.odx-d");
    expect(found.codes.get("5123")).toBe("Test sensor A fault");
    expect(found.conflicts).toEqual([
      "fault code 5123: kept 'Test sensor A fault', ignored 'A different text'",
    ]);
  });

  it("reads ODX inside a PDX archive and ignores other members", () => {
    const archive = zipSync({ "one.odx-d": bytes(ODX), "index.xml.txt": bytes("ignored") });
    expect(readDefinitions(archive, "test.pdx", "TestVariantA").codes.get("9003")).toBe(
      "Test sensor B fault",
    );
  });

  it("refuses an archive with no ODX files", () => {
    expect(() => readDefinitions(zipSync({ "readme.txt": bytes("x") }), "test.pdx")).toThrow(
      /no ODX files/,
    );
  });

  it("refuses a PDX that is not a zip archive", () => {
    expect(() => readDefinitions(bytes("not a zip"), "test.pdx")).toThrow(/not a zip archive/);
  });

  it("refuses an unknown variant", () => {
    expect(() => readDefinitions(bytes(ODX), "test.odx-d", "Nope")).toThrow(/named Nope/);
  });

  it("refuses entity declarations", () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>';
    expect(() => readDefinitions(bytes(bomb), "bomb.odx")).toThrow(/entity/);
  });

  it("refuses XML that is not well formed", () => {
    expect(() => readDefinitions(bytes("<ODX><a></ODX>"), "bad.odx")).toThrow(DefinitionError);
  });

  it("skips a trouble code that is not a number and notes it", () => {
    const odx = ODX.replace(
      "<TROUBLE-CODE>36867</TROUBLE-CODE>",
      "<TROUBLE-CODE>nope</TROUBLE-CODE>",
    );
    const found = readDefinitions(bytes(odx), "test.odx-d", "TestVariantA");
    expect(found.codes.has("9003")).toBe(false);
    expect(found.skipped).toEqual(["TestVariantA: trouble code 'nope' is not a number"]);
  });

  it("reads a hexadecimal trouble code", () => {
    const odx = ODX.replace(
      "<TROUBLE-CODE>36867</TROUBLE-CODE>",
      "<TROUBLE-CODE>0x9003</TROUBLE-CODE>",
    );
    expect(readDefinitions(bytes(odx), "test.odx-d", "TestVariantA").codes.get("9003")).toBe(
      "Test sensor B fault",
    );
  });

  it("ignores namespace prefixes", () => {
    const prefixed = ODX.replaceAll(/<(\/?)([A-Z])/g, "<$1o:$2").replace(
      "<o:ODX ",
      '<o:ODX xmlns:o="urn:x" ',
    );
    expect(readDefinitions(bytes(prefixed), "p.odx-d", "TestVariantA").codes.get("5123")).toBe(
      "Test sensor A fault",
    );
  });
});

describe("Trafo JSON", () => {
  it("gives codes and requests and notes what it skipped", () => {
    const found = readDefinitions(bytes(JSON.stringify(TRAFO)), "test.json", "TestVariantA");
    expect(found.codes).toEqual(
      new Map([
        ["5123", "Test sensor A fault"],
        ["P0420", "Test catalyst text"],
      ]),
    );
    expect(found.values).toEqual(new Map([["1A86", "Read test part number"]]));
    expect(found.skipped).toEqual([
      "TestVariantA: code 'DTC_NOT_HEX' is not hexadecimal or an SAE code",
    ]);
  });

  it("lists the variants when one is unknown", () => {
    expect(() => readDefinitions(bytes(JSON.stringify(TRAFO)), "test.json", "Nope")).toThrow(
      /no variant named Nope; it has TestVariantA, TestVariantB/,
    );
  });

  it("skips a byte-order mark", () => {
    const found = readDefinitions(
      bytes(`${String.fromCharCode(0xfeff)}${JSON.stringify(TRAFO)}`),
      "test.json",
      "TestVariantA",
    );
    expect(found.codes.size).toBe(2);
  });

  it("refuses JSON that is not Trafo output", () => {
    expect(() => readDefinitions(bytes("{}"), "x.json")).toThrow(DefinitionError);
    expect(() => readDefinitions(bytes("nope"), "x.json")).toThrow(DefinitionError);
  });
});

describe("other files", () => {
  it("refuses CBF files with advice", () => {
    expect(() => readDefinitions(Uint8Array.of(0), "x.cbf")).toThrow(/Trafo/);
  });
});
