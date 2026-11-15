import { describe, expect, it } from "vitest";
import {
  openJournalStorage,
  type JournalEntry,
  type JournalStore,
} from "../../src/web/journal-storage.js";
import { describeStorageContract } from "../support/storage-contract.js";

/** A journal that keeps its entries in an array, cloned as IndexedDB would. */
function arrayJournal(entries: JournalEntry[] = []): JournalStore & { entries: JournalEntry[] } {
  return {
    entries,
    load: () => Promise.resolve(structuredClone(entries)),
    append: (entry) => {
      entries.push(structuredClone(entry));
      return Promise.resolve();
    },
  };
}

describeStorageContract("journalled", async () => ({
  storage: await openJournalStorage(arrayJournal()),
  dispose: () => undefined,
}));

describe("journalled storage", () => {
  it("reopens with the same runs, ids, samples, reports and profiles", async () => {
    const journal = arrayJournal();
    const first = await openJournalStorage(journal);
    const run = await first.createRun({ profile: "p", adapter: "a", startedAt: 1, notes: "n" });
    await first.appendSamples([{ runId: run.id, signal: "s", unit: "V", timestamp: 2, value: 3 }]);
    const doomed = await first.createRun({ profile: "p", adapter: "a", startedAt: 5 });
    await first.deleteRun(doomed.id);
    await first.stopRun(run.id, 9);
    const report = await first.saveScanReport({
      profile: "p",
      adapter: "a",
      takenAt: 4,
      report: { ok: true },
    });
    await first.saveProfile({ name: "x", importedAt: 7, document: { name: "x" } });

    const second = await openJournalStorage(arrayJournal(journal.entries));
    expect(await second.listRuns()).toEqual(await first.listRuns());
    expect(await second.getRun(run.id)).toMatchObject({ stoppedAt: 9, notes: "n" });
    expect(await second.readSamples({ runId: run.id })).toEqual(
      await first.readSamples({ runId: run.id }),
    );
    expect(await second.getScanReport(report.id)).toEqual(report);
    expect(await second.listProfiles()).toEqual(await first.listProfiles());
    // New ids continue after the replayed ones instead of reusing them.
    const next = await second.createRun({ profile: "p", adapter: "a", startedAt: 10 });
    expect([run.id, doomed.id]).not.toContain(next.id);
  });

  it("does not record a change that failed", async () => {
    const journal = arrayJournal();
    const storage = await openJournalStorage(journal);
    await expect(storage.stopRun("nope", 1)).rejects.toMatchObject({ code: "not-found" });
    expect(journal.entries).toEqual([]);
  });

  it("refuses a journal entry it does not understand", async () => {
    const journal = arrayJournal([
      { op: "createRun", input: { profile: "", adapter: "a", startedAt: 1 } },
    ]);
    await expect(openJournalStorage(journal)).rejects.toBeInstanceOf(Error);
  });
});
