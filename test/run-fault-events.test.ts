import { describe, expect, it } from "vitest";
import {
  FAULT_SIGNALS,
  MemoryStorage,
  exportRunDelimitedText,
  exportRunJson,
  faultEvents,
  renderTable,
  runExportSchema,
  runFaultEventTable,
  runTableDocument,
  type Sample,
} from "../src/core/index.js";

const START = Date.parse("2026-11-15T10:00:00.000Z");

async function runWithFaults(): Promise<{ storage: MemoryStorage; runId: string }> {
  const storage = new MemoryStorage();
  const run = await storage.createRun({
    profile: "generic-obd2",
    adapter: "simulator://test",
    notes: "",
    startedAt: START,
  });
  const at = (seconds: number): number => START + seconds * 1000;
  const samples: Sample[] = [
    { runId: run.id, signal: FAULT_SIGNALS.stored, unit: "", timestamp: at(0), value: "P0302" },
    { runId: run.id, signal: "battery", unit: "V", timestamp: at(0), value: 12.6 },
    { runId: run.id, signal: FAULT_SIGNALS.pending, unit: "", timestamp: at(0), value: "none" },
    { runId: run.id, signal: "battery", unit: "V", timestamp: at(2.5), value: 12.4 },
    {
      runId: run.id,
      signal: FAULT_SIGNALS.stored,
      unit: "",
      timestamp: at(2.5),
      value: "P0420",
    },
    { runId: run.id, signal: FAULT_SIGNALS.pending, unit: "", timestamp: at(4), value: "P0171" },
  ];
  await storage.appendSamples(samples);
  return { storage, runId: run.id };
}

describe("a run's fault code events in its exports", () => {
  it("lists the events in the JSON export, which validates", async () => {
    const { storage, runId } = await runWithFaults();
    const exported = await exportRunJson(storage, runId);
    expect(runExportSchema.parse(exported)).toEqual(exported);
    expect(exported.faultEvents).toEqual(faultEvents(exported.samples));
    expect(exported.faultEvents).toEqual([
      { timestamp: START, list: "stored", code: "P0302", change: "appeared", atStart: true },
      {
        timestamp: START + 2500,
        list: "stored",
        code: "P0420",
        change: "appeared",
        atStart: false,
      },
      {
        timestamp: START + 2500,
        list: "stored",
        code: "P0302",
        change: "disappeared",
        atStart: false,
      },
      {
        timestamp: START + 4000,
        list: "pending",
        code: "P0171",
        change: "appeared",
        atStart: false,
      },
    ]);
  });

  it("reads a JSON export written before exports listed the events", async () => {
    const { storage, runId } = await runWithFaults();
    const { faultEvents: events, ...older } = await exportRunJson(storage, runId);
    expect(events).not.toHaveLength(0);
    expect(runExportSchema.parse(older)).toEqual(older);
  });

  it("writes the events as their own table, timed like the readings table", async () => {
    const { storage, runId } = await runWithFaults();
    const { run, faultEvents: events } = await exportRunJson(storage, runId);
    expect(renderTable("csv", runFaultEventTable(run.startedAt), events)).toBe(
      [
        "time,elapsed (s),list,code,change,at start",
        "2026-11-15T10:00:00.000Z,0.000,stored,P0302,appeared,yes",
        "2026-11-15T10:00:02.500Z,2.500,stored,P0420,appeared,no",
        "2026-11-15T10:00:02.500Z,2.500,stored,P0302,disappeared,no",
        "2026-11-15T10:00:04.000Z,4.000,pending,P0171,appeared,no",
        "",
      ].join("\r\n"),
    );
  });

  it("leaves the readings table as it was, the fault code lists as text columns", async () => {
    const { storage, runId } = await runWithFaults();
    expect(await exportRunDelimitedText(storage, runId, "csv")).toBe(
      [
        "time,elapsed (s),stored fault codes,battery (V),pending fault codes",
        "2026-11-15T10:00:00.000Z,0.000,P0302,12.6,none",
        "2026-11-15T10:00:02.500Z,2.500,P0420,12.4,",
        "2026-11-15T10:00:04.000Z,4.000,,,P0171",
        "",
      ].join("\r\n"),
    );
  });

  it("lists the events of a run read from its CSV export", async () => {
    const { storage, runId } = await runWithFaults();
    const text = await exportRunDelimitedText(storage, runId, "csv");
    const document = runTableDocument(text, { profile: "imported", adapter: "file", notes: "" });
    const { faultEvents: exported } = await exportRunJson(storage, runId);
    expect(exported).toHaveLength(4);
    expect(document.faultEvents).toEqual(exported);
  });
});
