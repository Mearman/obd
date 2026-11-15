import { describe, expect, it } from "vitest";
import {
  StorageError,
  buildCapture,
  exportRunCsvText,
  exportRunJson,
  runExportSchema,
  type Capture,
  type Exchange,
  type Sample,
  type Storage,
} from "../../src/core/index.js";

/** A storage under test and how to release it. */
export interface StorageFixture {
  readonly storage: Storage;
  readonly dispose: () => void | Promise<void>;
}

const T0 = 1_700_000_000_000;

function sample(runId: string, signal: string, offset: number, value: number | string): Sample {
  return {
    runId,
    signal,
    unit: typeof value === "number" ? "V" : "",
    timestamp: T0 + offset,
    value,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await rejection(promise);
  return error instanceof StorageError ? error.code : undefined;
}

/** A capture of invented exchanges: one answered unit read, one refused, one broadcast nobody answered. */
function inventedCapture(id: string, startedAt: number): Capture {
  const engine = {
    mode: "physical",
    requestId: 0x7e0,
    responseId: 0x7e8,
    extendedAddress: null,
  } as const;
  const exchanges: Exchange[] = [
    {
      seq: 0,
      at: startedAt,
      session: 0,
      bus: { kind: "can", idBits: 11, bitrate: 500_000 },
      address: engine,
      protocol: "kwp2000",
      request: "1A86",
      outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: ["5A86414243"] }] },
    },
    {
      seq: 1,
      at: startedAt + 1,
      session: 0,
      bus: { kind: "can", idBits: 11, bitrate: 500_000 },
      address: engine,
      protocol: "kwp2000",
      request: "2101",
      outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: ["7F2131"] }] },
    },
    {
      seq: 2,
      at: startedAt + 2,
      session: 0,
      bus: { kind: "can", idBits: 11, bitrate: 500_000 },
      address: { mode: "functional", requestId: 0x7df },
      protocol: "obd",
      request: "0902",
      outcome: { kind: "no-response", message: "no control unit answered" },
    },
  ];
  return buildCapture(
    {
      id,
      startedAt,
      endedAt: startedAt + 2,
      origin: { kind: "capture", profile: null, complete: true, description: "invented" },
      session: {
        adapter: {
          url: "simulator://generic-obd2",
          identity: "ELM327 v2.3",
          description: null,
          stnIdentity: null,
          voltage: "12.4V",
          hasStnExtensions: false,
        },
        tool: { name: "obd-read", version: "test" },
      },
      notes: ["a note"],
    },
    exchanges,
  );
}

/**
 * The behaviour every {@link Storage} must have. `open` returns a fresh, empty storage for each test.
 */
export function describeStorageContract(name: string, open: () => Promise<StorageFixture>): void {
  describe(`${name} storage contract`, () => {
    async function withStorage(body: (storage: Storage) => Promise<void>): Promise<void> {
      const fixture = await open();
      try {
        await body(fixture.storage);
      } finally {
        await fixture.dispose();
      }
    }

    const newRun = { profile: "mercedes-w211", adapter: "ble://vLinker", startedAt: T0 };

    it("creates runs open, with distinct ids and empty notes by default", () =>
      withStorage(async (storage) => {
        const first = await storage.createRun(newRun);
        const second = await storage.createRun({ ...newRun, notes: "cold start" });
        expect(first).toMatchObject({ ...newRun, stoppedAt: null, notes: "" });
        expect(second.notes).toBe("cold start");
        expect(second.id).not.toBe(first.id);
        expect(await storage.getRun(first.id)).toEqual(first);
        expect(await storage.getRun("nope")).toBeUndefined();
      }));

    it("stops a run once, never before it started", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        expect(await code(storage.stopRun(run.id, T0 - 1))).toBe("invalid");
        expect(await storage.stopRun(run.id, T0 + 5000)).toEqual({ ...run, stoppedAt: T0 + 5000 });
        expect(await code(storage.stopRun(run.id, T0 + 6000))).toBe("conflict");
        expect(await code(storage.stopRun("nope", T0))).toBe("not-found");
        expect((await storage.getRun(run.id))?.stoppedAt).toBe(T0 + 5000);
      }));

    it("replaces a run's notes", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        expect((await storage.setRunNotes(run.id, "idle")).notes).toBe("idle");
        expect((await storage.getRun(run.id))?.notes).toBe("idle");
        expect(await code(storage.setRunNotes("nope", "x"))).toBe("not-found");
      }));

    it("lists runs newest first, filtered by profile and paged", () =>
      withStorage(async (storage) => {
        const a = await storage.createRun({ ...newRun, startedAt: T0 });
        const b = await storage.createRun({ ...newRun, profile: "vag-mqb", startedAt: T0 + 10 });
        const c = await storage.createRun({ ...newRun, startedAt: T0 + 20 });
        expect((await storage.listRuns()).map((run) => run.id)).toEqual([c.id, b.id, a.id]);
        expect((await storage.listRuns({ profile: "mercedes-w211" })).map((run) => run.id)).toEqual(
          [c.id, a.id],
        );
        expect((await storage.listRuns({ limit: 1, offset: 1 })).map((run) => run.id)).toEqual([
          b.id,
        ]);
        expect((await storage.listRuns({ offset: 2 })).map((run) => run.id)).toEqual([a.id]);
      }));

    it("stores numeric and text samples and reads them in time order", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        await storage.appendSamples([
          sample(run.id, "battery", 2000, 12.4),
          sample(run.id, "battery", 0, 12.6),
          sample(run.id, "gear", 1000, "D"),
          sample(run.id, "battery", 1000, 12.5),
        ]);
        const all = await storage.readSamples({ runId: run.id });
        expect(all.map((s) => [s.signal, s.timestamp - T0, s.value])).toEqual([
          ["battery", 0, 12.6],
          ["gear", 1000, "D"],
          ["battery", 1000, 12.5],
          ["battery", 2000, 12.4],
        ]);
        expect(all[0]).toEqual({
          runId: run.id,
          signal: "battery",
          unit: "V",
          timestamp: T0,
          value: 12.6,
        });
        expect(all[1]).toMatchObject({ unit: "", value: "D" });
      }));

    it("keeps the order samples were stored in when their times are equal", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        await storage.appendSamples([sample(run.id, "a", 0, 1), sample(run.id, "b", 0, 2)]);
        await storage.appendSamples([sample(run.id, "c", 0, 3)]);
        expect((await storage.readSamples({ runId: run.id })).map((s) => s.signal)).toEqual([
          "a",
          "b",
          "c",
        ]);
      }));

    it("selects samples by signal and by a half-open time range, and pages them", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        await storage.appendSamples(
          [0, 1000, 2000, 3000].flatMap((offset) => [
            sample(run.id, "rpm", offset, offset),
            sample(run.id, "temp", offset, offset / 10),
          ]),
        );
        const rpm = await storage.readSamples({ runId: run.id, signal: "rpm" });
        expect(rpm.map((s) => s.value)).toEqual([0, 1000, 2000, 3000]);
        const middle = await storage.readSamples({
          runId: run.id,
          signal: "rpm",
          from: T0 + 1000,
          to: T0 + 3000,
        });
        expect(middle.map((s) => s.value)).toEqual([1000, 2000]);
        const page = await storage.readSamples({
          runId: run.id,
          signal: "rpm",
          limit: 2,
          offset: 1,
        });
        expect(page.map((s) => s.value)).toEqual([1000, 2000]);
        const tail = await storage.readSamples({ runId: run.id, signal: "rpm", offset: 3 });
        expect(tail.map((s) => s.value)).toEqual([3000]);
        expect(await storage.readSamples({ runId: "nope" })).toEqual([]);
      }));

    it("keeps one run's samples out of another's", () =>
      withStorage(async (storage) => {
        const one = await storage.createRun(newRun);
        const two = await storage.createRun(newRun);
        await storage.appendSamples([sample(one.id, "x", 0, 1), sample(two.id, "x", 0, 2)]);
        expect((await storage.readSamples({ runId: one.id })).map((s) => s.value)).toEqual([1]);
        expect((await storage.readSamples({ runId: two.id })).map((s) => s.value)).toEqual([2]);
      }));

    it("stores a large batch", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        const batch = Array.from({ length: 1234 }, (_, index) => sample(run.id, "n", index, index));
        await storage.appendSamples(batch);
        const read = await storage.readSamples({ runId: run.id });
        expect(read).toHaveLength(1234);
        expect(read.at(-1)?.value).toBe(1233);
      }));

    it("stores nothing when any sample in a batch is refused", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        const stopped = await storage.createRun(newRun);
        await storage.stopRun(stopped.id, T0 + 1);
        expect(
          await code(storage.appendSamples([sample(run.id, "a", 0, 1), sample("nope", "a", 0, 1)])),
        ).toBe("not-found");
        expect(
          await code(
            storage.appendSamples([sample(run.id, "a", 0, 1), sample(stopped.id, "a", 0, 1)]),
          ),
        ).toBe("conflict");
        expect(
          await rejection(storage.appendSamples([sample(run.id, "a", 0, Number.NaN)])),
        ).toBeInstanceOf(Error);
        expect(await storage.readSamples({ runId: run.id })).toEqual([]);
        await storage.appendSamples([]);
      }));

    it("aggregates per signal and unit over a range, ignoring text for the numeric figures", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        await storage.appendSamples([
          sample(run.id, "battery", 0, 12),
          sample(run.id, "battery", 1000, 14),
          sample(run.id, "battery", 2000, 13),
          sample(run.id, "gear", 500, "D"),
          sample(run.id, "gear", 1500, "N"),
          { runId: run.id, signal: "battery", unit: "mV", timestamp: T0 + 3000, value: 12500 },
        ]);
        expect(await storage.aggregate({ runId: run.id })).toEqual([
          {
            signal: "battery",
            unit: "V",
            count: 3,
            numericCount: 3,
            min: 12,
            max: 14,
            mean: 13,
            firstAt: T0,
            lastAt: T0 + 2000,
          },
          {
            signal: "battery",
            unit: "mV",
            count: 1,
            numericCount: 1,
            min: 12500,
            max: 12500,
            mean: 12500,
            firstAt: T0 + 3000,
            lastAt: T0 + 3000,
          },
          {
            signal: "gear",
            unit: "",
            count: 2,
            numericCount: 0,
            min: null,
            max: null,
            mean: null,
            firstAt: T0 + 500,
            lastAt: T0 + 1500,
          },
        ]);
        expect(
          await storage.aggregate({
            runId: run.id,
            signal: "battery",
            from: T0 + 1000,
            to: T0 + 3000,
          }),
        ).toEqual([
          {
            signal: "battery",
            unit: "V",
            count: 2,
            numericCount: 2,
            min: 13,
            max: 14,
            mean: 13.5,
            firstAt: T0 + 1000,
            lastAt: T0 + 2000,
          },
        ]);
        expect(await storage.aggregate({ runId: "nope" })).toEqual([]);
      }));

    it("deletes a run with its samples and leaves other runs alone", () =>
      withStorage(async (storage) => {
        const gone = await storage.createRun(newRun);
        const kept = await storage.createRun(newRun);
        await storage.appendSamples([sample(gone.id, "a", 0, 1), sample(kept.id, "a", 0, 2)]);
        await storage.deleteRun(gone.id);
        await storage.deleteRun("nope");
        expect(await storage.getRun(gone.id)).toBeUndefined();
        expect(await storage.readSamples({ runId: gone.id })).toEqual([]);
        expect(await storage.readSamples({ runId: kept.id })).toHaveLength(1);
      }));

    it("saves, lists, reads and deletes scan reports", () =>
      withStorage(async (storage) => {
        const body = {
          taken: "2026-11-02",
          units: [{ name: "engine", answered: true }],
          note: null,
        };
        const older = await storage.saveScanReport({
          profile: "mercedes-w211",
          adapter: "ble://vLinker",
          takenAt: T0,
          label: "before",
          report: body,
        });
        const newer = await storage.saveScanReport({
          profile: "vag-mqb",
          adapter: "tcp://192.168.80.1:35000",
          takenAt: T0 + 100,
          report: [1, "two", false],
        });
        expect(older).toMatchObject({ label: "before", report: body });
        expect(newer.label).toBe("");
        expect(await storage.getScanReport(older.id)).toEqual(older);
        expect(await storage.getScanReport(newer.id)).toEqual(newer);
        expect(await storage.getScanReport("nope")).toBeUndefined();
        expect(await storage.listScanReports()).toEqual([
          {
            id: newer.id,
            profile: "vag-mqb",
            adapter: newer.adapter,
            takenAt: T0 + 100,
            label: "",
            origin: "local",
          },
          {
            id: older.id,
            profile: "mercedes-w211",
            adapter: older.adapter,
            takenAt: T0,
            label: "before",
            origin: "local",
          },
        ]);
        expect(
          (await storage.listScanReports({ profile: "mercedes-w211" })).map((r) => r.id),
        ).toEqual([older.id]);
        expect((await storage.listScanReports({ limit: 1 })).map((r) => r.id)).toEqual([newer.id]);
        await storage.deleteScanReport(newer.id);
        await storage.deleteScanReport("nope");
        expect(await storage.getScanReport(newer.id)).toBeUndefined();
      }));

    it("saves, lists, reads and deletes captures, keeping every exchange", () =>
      withStorage(async (storage) => {
        const older = inventedCapture("capture-a", T0);
        const newer = inventedCapture("capture-b", T0 + 100);
        const summary = await storage.saveCapture(older, "local");
        expect(summary).toEqual({
          id: "capture-a",
          startedAt: T0,
          endedAt: T0 + 2,
          kind: "capture",
          profile: null,
          complete: true,
          description: "invented",
          adapter: "ELM327 v2.3",
          exchanges: 3,
          units: [
            { address: "physical:2016:2024:null", label: "7E0 -> 7E8", exchanges: 2, answered: 2 },
            { address: "functional:2015", label: "functional 7DF", exchanges: 1, answered: 0 },
          ],
          origin: "local",
        });
        await storage.saveCapture(newer, "local");
        expect(await storage.getCapture("capture-a")).toEqual(older);
        expect(await storage.getCapture("nope")).toBeUndefined();
        expect((await storage.listCaptures()).map((capture) => capture.id)).toEqual([
          "capture-b",
          "capture-a",
        ]);
        expect(await storage.listCaptures({ limit: 1, offset: 1 })).toEqual([summary]);
        expect(await code(storage.saveCapture(older, "shared"))).toBe("conflict");
        await storage.deleteCapture("capture-b");
        await storage.deleteCapture("nope");
        expect(await storage.getCapture("capture-b")).toBeUndefined();
        expect((await storage.listCaptures()).map((capture) => capture.id)).toEqual(["capture-a"]);
      }));

    it("refuses a capture that breaks the document's rules", () =>
      withStorage(async (storage) => {
        const capture = inventedCapture("capture-a", T0);
        const reordered: Capture = { ...capture, exchanges: [...capture.exchanges].reverse() };
        await expect(storage.saveCapture(reordered, "local")).rejects.toThrow();
        expect(await storage.listCaptures()).toEqual([]);
      }));

    it("records where each run, report and capture came from, local unless told otherwise, and filters by it", () =>
      withStorage(async (storage) => {
        const own = await storage.createRun({ profile: "p", adapter: "a", startedAt: T0 });
        const shared = await storage.createRun({
          profile: "p",
          adapter: "a",
          startedAt: T0 + 1,
          origin: "shared",
        });
        expect(own.origin).toBe("local");
        expect((await storage.getRun(shared.id))?.origin).toBe("shared");
        expect((await storage.listRuns({ origin: "shared" })).map((run) => run.id)).toEqual([
          shared.id,
        ]);
        expect((await storage.listRuns({ origin: "local" })).map((run) => run.id)).toEqual([
          own.id,
        ]);
        expect(await storage.listRuns({ origin: "imported" })).toEqual([]);

        const report = { profile: "p", adapter: "a", takenAt: T0, report: { tool: "obd-read" } };
        const ownReport = await storage.saveScanReport(report);
        const sharedReport = await storage.saveScanReport({ ...report, origin: "shared" });
        expect(ownReport.origin).toBe("local");
        expect((await storage.getScanReport(sharedReport.id))?.origin).toBe("shared");
        expect(
          (await storage.listScanReports({ origin: "shared" })).map((summary) => [
            summary.id,
            summary.origin,
          ]),
        ).toEqual([[sharedReport.id, "shared"]]);

        await storage.saveCapture(inventedCapture("capture-own", T0), "local");
        await storage.saveCapture(inventedCapture("capture-shared", T0 + 1), "shared");
        await storage.saveCapture(inventedCapture("capture-file", T0 + 2), "imported");
        expect(
          (await storage.listCaptures()).map((capture) => [capture.id, capture.origin]),
        ).toEqual([
          ["capture-file", "imported"],
          ["capture-shared", "shared"],
          ["capture-own", "local"],
        ]);
        expect((await storage.listCaptures({ origin: "shared" })).map((c) => c.id)).toEqual([
          "capture-shared",
        ]);
      }));

    it("keeps imported profiles by name, replacing a profile imported twice", () =>
      withStorage(async (storage) => {
        expect(
          await storage.saveProfile({ name: "b", importedAt: T0, document: { v: 1 } }),
        ).toEqual({ replaced: false });
        await storage.saveProfile({ name: "a", importedAt: T0, document: ["x"] });
        expect(
          await storage.saveProfile({ name: "b", importedAt: T0 + 1, document: { v: 2 } }),
        ).toEqual({ replaced: true });
        expect(await storage.getProfile("b")).toEqual({
          name: "b",
          importedAt: T0 + 1,
          document: { v: 2 },
        });
        expect((await storage.listProfiles()).map((p) => p.name)).toEqual(["a", "b"]);
        expect(await storage.getProfile("nope")).toBeUndefined();
      }));

    it("serialises calls made without waiting for each other", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun(newRun);
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            storage.appendSamples([sample(run.id, "n", index, index)]),
          ),
        );
        expect((await storage.readSamples({ runId: run.id })).map((s) => s.value)).toEqual(
          Array.from({ length: 20 }, (_, index) => index),
        );
      }));

    it("exports a run as JSON that validates and as CSV in the live-log layout", () =>
      withStorage(async (storage) => {
        const run = await storage.createRun({ ...newRun, notes: 'a, "quoted" note' });
        await storage.appendSamples([
          sample(run.id, "battery", 0, 12.6),
          sample(run.id, "rpm", 0, 780),
          sample(run.id, "battery", 1500, 12.123456789012),
          sample(run.id, "gear", 1500, "D"),
          sample(run.id, "battery", 1500, 12.0),
        ]);
        const exported = await exportRunJson(storage, run.id);
        expect(runExportSchema.parse(exported)).toEqual(exported);
        expect(exported.run).toEqual(run);
        expect(exported.samples).toHaveLength(5);
        expect(await exportRunCsvText(storage, run.id)).toBe(
          [
            "time,elapsed (s),battery (V),rpm (V),gear",
            "2023-11-14T22:13:20.000Z,0.000,12.6,780,",
            "2023-11-14T22:13:21.500Z,1.500,12.12345679,,D",
            "2023-11-14T22:13:21.500Z,1.500,12,,",
            "",
          ].join("\r\n"),
        );
        expect(await code(exportRunJson(storage, "nope"))).toBe("not-found");
        expect(await code(exportRunCsvText(storage, "nope"))).toBe("not-found");
      }));
  });
}
