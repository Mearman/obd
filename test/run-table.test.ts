import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  RunImportError,
  TabularError,
  exportRunDelimitedText,
  importRunTable,
  parseRunTable,
  runTable,
  runTableDocument,
  type Sample,
} from "../src/core/index.js";
import { SIMULATOR, eventually, newSimulatedService } from "./support/host-rig.js";

const DETAILS = { profile: "imported-file", adapter: "file run", notes: "" };

/** The value as an export writes it: numbers to ten significant digits. */
function written(value: Sample["value"]): Sample["value"] {
  return typeof value === "number" ? Number(value.toPrecision(10)) : value;
}

const content = (samples: readonly Sample[]) =>
  samples.map(({ signal, unit, timestamp, value }) => ({
    signal,
    unit,
    timestamp,
    value: written(value),
  }));

describe("a simulator run exported and imported", () => {
  it.each(["csv", "tsv"] as const)("comes back from %s with the same samples", async (format) => {
    const { host, storage } = newSimulatedService();
    const run = await host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR });
    await eventually(async () => {
      const aggregate = await host.client.runs.aggregate({ runId: run.id });
      return aggregate.length >= 3 && aggregate.every((row) => row.count >= 3) ? true : undefined;
    });
    await host.client.runs.stop({ runId: run.id });

    const original = await storage.readSamples({ runId: run.id });
    expect(original.length).toBeGreaterThan(8);
    const exported = await host.client.runs.export({ runId: run.id, format });
    expect(exported.filename).toBe(`obd-read-run-${run.id}.${format}`);

    const imported = await host.client.runs.import({
      text: exported.content,
      name: exported.filename,
    });
    expect(imported.origin).toBe("imported");
    expect(imported.stoppedAt).not.toBeNull();
    expect(imported.startedAt).toBe(run.startedAt);
    expect(imported.id).not.toBe(run.id);
    const restored = await storage.readSamples({ runId: imported.id });
    expect(content(restored)).toEqual(content(original));

    // The imported run exports to the same text.
    const again = await host.client.runs.export({ runId: imported.id, format });
    expect(again.content).toBe(exported.content);
  });
});

describe("runTable", () => {
  const sample = (
    signal: string,
    unit: string,
    timestamp: number,
    value: Sample["value"],
  ): Sample => ({
    runId: "r",
    signal,
    unit,
    timestamp,
    value,
  });

  it("puts readings that share a timestamp on one row and repeated readings on another", () => {
    const table = runTable(1000, [
      sample("a", "V", 1000, 1.5),
      sample("b", "", 1000, "D"),
      sample("a", "V", 1000, 2),
      sample("a", "V", 3000, 3),
    ]);
    expect(table.header).toEqual(["time", "elapsed (s)", "a (V)", "b"]);
    expect(table.rows).toEqual([
      ["1970-01-01T00:00:01.000Z", "0.000", "1.5", "D"],
      ["1970-01-01T00:00:01.000Z", "0.000", "2", ""],
      ["1970-01-01T00:00:03.000Z", "2.000", "3", ""],
    ]);
  });
});

describe("a run read from text", () => {
  const csv = (rows: string[]) =>
    ["time,elapsed (s),speed (km/h),gear", ...rows].join("\r\n") + "\r\n";

  it("reads numbers, text, empty cells and the start of the run", () => {
    const parsed = parseRunTable(
      csv([
        "2026-11-15T10:00:01.500Z,1.500,50,D",
        "2026-11-15T10:00:02.500Z,2.500,,N",
        "2026-11-15T10:00:03.000Z,3.000,60,",
      ]),
    );
    expect(parsed.startedAt).toBe(Date.parse("2026-11-15T10:00:00.000Z"));
    expect(parsed.samples).toEqual([
      {
        signal: "speed",
        unit: "km/h",
        timestamp: Date.parse("2026-11-15T10:00:01.500Z"),
        value: 50,
      },
      { signal: "gear", unit: "", timestamp: Date.parse("2026-11-15T10:00:01.500Z"), value: "D" },
      { signal: "gear", unit: "", timestamp: Date.parse("2026-11-15T10:00:02.500Z"), value: "N" },
      {
        signal: "speed",
        unit: "km/h",
        timestamp: Date.parse("2026-11-15T10:00:03.000Z"),
        value: 60,
      },
    ]);
  });

  it("reads a TSV export by its first header column", () => {
    const parsed = parseRunTable("time\telapsed (s)\ta\n2026-11-15T10:00:00.000Z\t0.000\t1\n");
    expect(parsed.samples).toEqual([
      { signal: "a", unit: "", timestamp: Date.parse("2026-11-15T10:00:00.000Z"), value: 1 },
    ]);
  });

  it.each([
    ["", /empty/],
    ["when,elapsed (s),a\r\n", /column 1 of the header is "when" and a run export has "time"/],
    [
      "time,seconds,a\r\n",
      /column 2 of the header is "seconds" and a run export has "elapsed \(s\)"/,
    ],
    ["time\r\n", /column 2 of the header is missing/],
    ["time,elapsed (s),a,\r\n", /column 4 of the header is empty/],
    ["time,elapsed (s),a,a\r\n", /column 4 of the header repeats column 3, "a"/],
    ["time,elapsed (s),a\r\n", /no rows/],
    ["time,elapsed (s),a\r\n2026-11-15T10:00:00.000Z,0.000\r\n", /row 2 has 2 columns/],
    ["time,elapsed (s),a\r\nyesterday,0.000,1\r\n", /row 2 has the time "yesterday"/],
    ["time,elapsed (s),a\r\n2026-11-15T10:00:00.000Z,soon,1\r\n", /elapsed time "soon"/],
  ])("refuses %j", (text, message) => {
    expect(() => parseRunTable(text)).toThrow(RunImportError);
    expect(() => parseRunTable(text)).toThrow(message);
  });

  it("refuses text that is not valid CSV", () => {
    expect(() => parseRunTable('time,elapsed (s)\r\n"open')).toThrow(TabularError);
  });

  it("stores nothing when a reading is refused and stores an imported, stopped run otherwise", async () => {
    const storage = new MemoryStorage();
    await expect(importRunTable(storage, "when,elapsed (s)\r\n", DETAILS)).rejects.toThrow(
      RunImportError,
    );
    expect(await storage.listRuns()).toEqual([]);
    const run = await importRunTable(
      storage,
      csv(["2026-11-15T10:00:01.500Z,1.500,50,D"]),
      DETAILS,
    );
    expect(run).toMatchObject({
      origin: "imported",
      adapter: "file run",
      startedAt: Date.parse("2026-11-15T10:00:00.000Z"),
      stoppedAt: Date.parse("2026-11-15T10:00:01.500Z"),
    });
    expect(await exportRunDelimitedText(storage, run.id, "csv")).toBe(
      csv(["2026-11-15T10:00:01.500Z,1.500,50,D"]),
    );
  });

  it("makes a run export document for sharing", () => {
    const document = runTableDocument(csv(["2026-11-15T10:00:01.500Z,1.500,50,D"]), DETAILS);
    expect(document).toMatchObject({ format: "obd-read-run", run: { origin: "imported" } });
    expect(document.samples).toHaveLength(2);
  });
});
