import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allowsWrites,
  compareReport,
  obdReportDocumentShareData,
  parseScan,
  sharedObdReportDocument,
  sharedRunSamples,
  sharedRunStop,
  sharedScanReport,
  type ObdReportShareData,
  type RunSummaryShareData,
  type ScanShareData,
} from "../src/core/index.js";
import { SIMULATOR, newSimulatedService } from "./support/host-rig.js";

const SCAN: ScanShareData = {
  taken: "2026-11-15T10:00:00+00:00",
  profile: { name: "mercedes-w211" },
  adapter: { label: "ELM327 v1.5" },
  redacted: true,
  units: [
    {
      unit: "engine",
      description: "Engine control",
      request_id: "7E0",
      response_id: "7E8",
      answered: true,
      notes: [],
      identification: {},
      faults: [{ code: "P0420", status: "2F" }],
      freeze_frames: {},
    },
  ],
};

const OBD: ObdReportShareData = {
  taken: "2026-11-15T10:00:00+00:00",
  adapter: { label: "ELM327 v1.5" },
  redacted: false,
  obd: {
    vin: "TESTVAN0000000001",
    units: [],
    values: [{ sender: "7E8", signal: "engine speed", unit: "rpm", value: 800 }],
    monitorResults: [],
    notes: [],
  },
};

const RUN: RunSummaryShareData = {
  run: {
    profile: "generic-obd2",
    adapter: "ELM327 v1.5",
    startedAt: 1_790_000_000_000,
    stoppedAt: null,
    notes: "warm idle",
  },
  signals: [
    {
      signal: "engine speed",
      unit: "rpm",
      count: 300,
      numericCount: 300,
      min: 700,
      max: 900,
      mean: 800,
      firstAt: 1_790_000_000_000,
      lastAt: 1_790_000_002_000,
      series: [
        [0, 700],
        [2000, 900],
      ],
    },
    {
      signal: "coolant temperature",
      unit: "°C",
      count: 2,
      numericCount: 2,
      min: 80,
      max: 81,
      mean: 80.5,
      firstAt: 1_790_000_000_500,
      lastAt: 1_790_000_001_500,
      series: [
        [500, 80],
        [1500, 81],
      ],
    },
  ],
};

describe("where a record came from", () => {
  it("allows write-type actions only on what this device read itself", () => {
    expect(allowsWrites("local")).toBe(true);
    expect(allowsWrites("shared")).toBe(false);
    expect(allowsWrites("imported")).toBe(false);
  });
});

describe("a shared read kept by the user", () => {
  it("is stored as the document obd --output writes, marked shared, and shares back the same read", () => {
    const document = sharedObdReportDocument(OBD);
    expect(document).toMatchObject({ tool: "obd-read", format: "obd-report", origin: "shared" });
    const again = obdReportDocumentShareData(document);
    expect(again).toEqual({ ok: true, value: OBD });
  });

  it("keeps a run summary's readings as samples at the run's start plus each offset, in time order", () => {
    expect(sharedRunSamples(RUN, "r1")).toEqual([
      {
        runId: "r1",
        signal: "engine speed",
        unit: "rpm",
        timestamp: 1_790_000_000_000,
        value: 700,
      },
      {
        runId: "r1",
        signal: "coolant temperature",
        unit: "°C",
        timestamp: 1_790_000_000_500,
        value: 80,
      },
      {
        runId: "r1",
        signal: "coolant temperature",
        unit: "°C",
        timestamp: 1_790_000_001_500,
        value: 81,
      },
      {
        runId: "r1",
        signal: "engine speed",
        unit: "rpm",
        timestamp: 1_790_000_002_000,
        value: 900,
      },
    ]);
    expect(sharedRunStop(RUN)).toBe(1_790_000_002_000);
    expect(sharedRunStop({ ...RUN, run: { ...RUN.run, stoppedAt: 1_790_000_009_000 } })).toBe(
      1_790_000_009_000,
    );
  });
});

describe("a comparison", () => {
  const own = JSON.stringify({ tool: "obd-read", ...sharedScanReport(SCAN), origin: undefined });
  const shared = JSON.stringify(sharedScanReport(SCAN));

  it("says which side is shared data", () => {
    const lines = compareReport(parseScan(own, "mine.json"), parseScan(shared, "theirs.json"));
    expect(lines).toContain(
      "note: the second scan is shared data from a link, not read from your adapter",
    );
    expect(lines.join("\n")).not.toContain("the first scan is shared");
    const reversed = compareReport(parseScan(shared, "theirs.json"), parseScan(own, "mine.json"));
    expect(reversed).toContain(
      "note: the first scan is shared data from a link, not read from your adapter",
    );
  });

  it("adds nothing when neither side is shared", () => {
    const lines = compareReport(parseScan(own, "a.json"), parseScan(own, "b.json"));
    expect(lines.join("\n")).not.toContain("shared");
  });
});

describe("origin through the service", () => {
  it("marks an imported capture imported and one the service captured local, and filters by it", async () => {
    const { host } = newSimulatedService();
    await host.client.link.connect({ profile: "mercedes-w211", adapter: SIMULATOR });
    const started = await host.client.captures.start({});
    for await (const status of await host.client.captures.progress({ id: started.id })) {
      if (status.state !== "capturing") break;
    }
    const lines = readFileSync(new URL("fixtures/a150-since-clear.txt", import.meta.url), "utf8");
    const imported = await host.client.captures.import({ text: lines, name: "a150.log" });
    expect(imported.summary.origin).toBe("imported");
    expect((await host.client.captures.list({ origin: "local" })).map((c) => c.id)).toEqual([
      started.id,
    ]);
    expect((await host.client.captures.list({ origin: "imported" })).map((c) => c.id)).toEqual([
      imported.summary.id,
    ]);
  });

  it("refuses to collect into a run that was not read here", async () => {
    const { host, storage } = newSimulatedService();
    await host.client.link.connect({ profile: "mercedes-w211", adapter: SIMULATOR });
    const shared = await storage.createRun({
      profile: "mercedes-w211",
      adapter: "ELM327 v1.5",
      startedAt: 1,
      origin: "shared",
    });
    await expect(host.client.runs.resume({ runId: shared.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await host.client.runs.list({ origin: "shared" })).map((run) => run.id)).toEqual([
      shared.id,
    ]);
  });
});
