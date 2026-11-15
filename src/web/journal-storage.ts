/**
 * Storage that survives a reload without a database: the in-memory {@link Storage} plus a journal of every change.
 *
 * Each successful change is appended to a {@link JournalStore} after it is applied. Opening the storage replays the journal into a fresh {@link MemoryStorage}; because that store assigns ids from a counter, replaying the same calls in order reproduces the same state and the same ids. This is the persistence the app uses until the SQLite worker takes the `Storage` interface over, and it holds the whole data set in memory, so it suits runs of minutes, not days.
 *
 * {@link indexedDbJournal} is the journal for a browser; tests pass one that keeps entries in an array.
 */

import { MemoryStorage } from "../core/testing/memory-storage.js";
import { z } from "zod";
import {
  newRunSchema,
  newScanReportSchema,
  sampleSchema,
  storedProfileSchema,
  type AggregateQuery,
  type NewRun,
  type NewScanReport,
  type Run,
  type RunQuery,
  type Sample,
  type SampleQuery,
  type ScanReport,
  type ScanReportQuery,
  type ScanReportSummary,
  type SignalAggregate,
  type Storage,
  type StoredProfile,
} from "../core/storage.js";

const nameSchema = z.string().min(1);

/** One change that was applied to the storage, as it is kept in the journal. */
export const journalEntrySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("createRun"), input: newRunSchema }),
  z.object({ op: z.literal("stopRun"), runId: nameSchema, stoppedAt: z.number() }),
  z.object({ op: z.literal("setRunNotes"), runId: nameSchema, notes: z.string() }),
  z.object({ op: z.literal("deleteRun"), runId: nameSchema }),
  z.object({ op: z.literal("appendSamples"), samples: z.array(sampleSchema) }),
  z.object({ op: z.literal("saveScanReport"), input: newScanReportSchema }),
  z.object({ op: z.literal("deleteScanReport"), id: nameSchema }),
  z.object({ op: z.literal("saveProfile"), profile: storedProfileSchema }),
]);

/** One change that was applied to the storage. */
export type JournalEntry = z.input<typeof journalEntrySchema>;

/** Where the journal is kept. */
export interface JournalStore {
  /** Every entry appended so far, oldest first. */
  load(): Promise<readonly JournalEntry[]>;
  /** Adds one entry after the ones already there; resolves once it is durable. */
  append(entry: JournalEntry): Promise<void>;
}

async function replay(inner: MemoryStorage, entry: JournalEntry): Promise<void> {
  switch (entry.op) {
    case "createRun":
      await inner.createRun(entry.input);
      return;
    case "stopRun":
      await inner.stopRun(entry.runId, entry.stoppedAt);
      return;
    case "setRunNotes":
      await inner.setRunNotes(entry.runId, entry.notes);
      return;
    case "deleteRun":
      await inner.deleteRun(entry.runId);
      return;
    case "appendSamples":
      await inner.appendSamples(entry.samples);
      return;
    case "saveScanReport":
      await inner.saveScanReport(entry.input);
      return;
    case "deleteScanReport":
      await inner.deleteScanReport(entry.id);
      return;
    case "saveProfile":
      await inner.saveProfile(entry.profile);
      return;
  }
}

class JournalStorage implements Storage {
  constructor(
    private readonly inner: MemoryStorage,
    private readonly journal: JournalStore,
  ) {}

  /** Applies a change, then records it; a change that throws is not recorded. */
  private async recorded<T>(entry: JournalEntry, apply: () => Promise<T>): Promise<T> {
    const result = await apply();
    await this.journal.append(entry);
    return result;
  }

  createRun(input: NewRun): Promise<Run> {
    return this.recorded({ op: "createRun", input }, () => this.inner.createRun(input));
  }

  stopRun(runId: string, stoppedAt: number): Promise<Run> {
    return this.recorded({ op: "stopRun", runId, stoppedAt }, () =>
      this.inner.stopRun(runId, stoppedAt),
    );
  }

  setRunNotes(runId: string, notes: string): Promise<Run> {
    return this.recorded({ op: "setRunNotes", runId, notes }, () =>
      this.inner.setRunNotes(runId, notes),
    );
  }

  getRun(runId: string): Promise<Run | undefined> {
    return this.inner.getRun(runId);
  }

  listRuns(query?: RunQuery): Promise<Run[]> {
    return this.inner.listRuns(query);
  }

  deleteRun(runId: string): Promise<void> {
    return this.recorded({ op: "deleteRun", runId }, () => this.inner.deleteRun(runId));
  }

  appendSamples(samples: readonly Sample[]): Promise<void> {
    return this.recorded({ op: "appendSamples", samples: [...samples] }, () =>
      this.inner.appendSamples(samples),
    );
  }

  readSamples(query: SampleQuery): Promise<Sample[]> {
    return this.inner.readSamples(query);
  }

  aggregate(query: AggregateQuery): Promise<SignalAggregate[]> {
    return this.inner.aggregate(query);
  }

  saveScanReport(input: NewScanReport): Promise<ScanReport> {
    return this.recorded({ op: "saveScanReport", input }, () => this.inner.saveScanReport(input));
  }

  getScanReport(id: string): Promise<ScanReport | undefined> {
    return this.inner.getScanReport(id);
  }

  listScanReports(query?: ScanReportQuery): Promise<ScanReportSummary[]> {
    return this.inner.listScanReports(query);
  }

  deleteScanReport(id: string): Promise<void> {
    return this.recorded({ op: "deleteScanReport", id }, () => this.inner.deleteScanReport(id));
  }

  saveProfile(profile: StoredProfile): Promise<{ readonly replaced: boolean }> {
    return this.recorded({ op: "saveProfile", profile }, () => this.inner.saveProfile(profile));
  }

  getProfile(name: string): Promise<StoredProfile | undefined> {
    return this.inner.getProfile(name);
  }

  listProfiles(): Promise<StoredProfile[]> {
    return this.inner.listProfiles();
  }
}

/**
 * Opens storage over `journal`, replaying what it holds.
 *
 * Calls on the result behave as {@link MemoryStorage}'s do, and each change is durable in `journal` before its promise resolves. Only one storage may be open over a journal at a time.
 */
export async function openJournalStorage(journal: JournalStore): Promise<Storage> {
  const inner = new MemoryStorage();
  for (const entry of await journal.load()) await replay(inner, entry);
  return new JournalStorage(inner, journal);
}

const STORE = "entries";

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.addEventListener("success", () => {
      resolve(source.result);
    });
    source.addEventListener("error", () => {
      reject(source.error ?? new Error("IndexedDB request failed"));
    });
  });
}

/**
 * A journal in IndexedDB: one record per entry, keyed by an increasing number so the order survives.
 *
 * @param name The database name.
 */
export async function indexedDbJournal(name: string, factory: IDBFactory): Promise<JournalStore> {
  const opening = factory.open(name, 1);
  opening.addEventListener("upgradeneeded", () => {
    opening.result.createObjectStore(STORE, { autoIncrement: true });
  });
  const database = await request(opening);
  return {
    load: async () => {
      const entries: unknown[] = await request(
        database.transaction(STORE, "readonly").objectStore(STORE).getAll(),
      );
      return entries.map((entry) => journalEntrySchema.parse(entry));
    },
    append: async (entry) => {
      const transaction = database.transaction(STORE, "readwrite");
      const done = new Promise<void>((resolve, reject) => {
        transaction.addEventListener("complete", () => {
          resolve();
        });
        transaction.addEventListener("error", () => {
          reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        });
        transaction.addEventListener("abort", () => {
          reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        });
      });
      transaction.objectStore(STORE).add(entry);
      await done;
    },
  };
}
