/**
 * The SQLite implementation of the core {@link Storage} contract, written with Drizzle ORM over its `sqlite-proxy` driver.
 *
 * It runs SQL only through an injected {@link SqlExecutor}, so the same code serves Node (`node:sqlite`) and the browser (sqlite-wasm in a worker). Drizzle and its prerelease API stay inside this directory: callers see only `Storage`.
 */

import { and, asc, avg, count, desc, eq, gte, inArray, lt, max, min, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createSelectSchema } from "drizzle-orm/zod";
import { validateCapture, type Capture } from "../core/capture.js";
import { compressCapture, readCaptureFile } from "../core/capture-file.js";
import {
  StorageError,
  captureSummary,
  captureSummarySchema,
  jsonSchema,
  newRunSchema,
  newScanReportSchema,
  runSchema,
  sampleSchema,
  scanReportSchema,
  scanReportSummarySchema,
  signalAggregateSchema,
  storedPlanSchema,
  storedProfileSchema,
  type AggregateQuery,
  type CaptureQuery,
  type CaptureSummary,
  type NewRun,
  type NewScanReport,
  type Origin,
  type Run,
  type RunQuery,
  type Sample,
  type SampleQuery,
  type ScanReport,
  type ScanReportQuery,
  type ScanReportSummary,
  type SignalAggregate,
  type Storage,
  type StoredPlan,
  type StoredProfile,
} from "../core/storage.js";
import { proxyExecutors, type SqlExecutor } from "./executor.js";
import { applyMigrations } from "./migrate.js";
import { captureUnits, captures, plans, profiles, runs, samples, scanReports } from "./schema.js";

/**
 * Rows stored per INSERT. Each sample binds six parameters, and SQLite refuses a statement binding more than 32,766 of them, so a batch is split well below that.
 */
const INSERT_ROWS = 500;

/** Row validators derived from the tables, so a row an executor returns is checked against the schema it was written with. */
const runRow = createSelectSchema(runs).transform((row) => runSchema.parse(row));
const sampleRow = createSelectSchema(samples).transform((row) =>
  sampleSchema.parse({
    runId: row.runId,
    signal: row.signal,
    unit: row.unit,
    timestamp: row.timestamp,
    value: row.valueNum ?? row.valueText,
  }),
);
const reportRow = createSelectSchema(scanReports).transform((row) =>
  scanReportSchema.parse({ ...row, report: jsonSchema.parse(JSON.parse(row.report)) }),
);
const profileRow = createSelectSchema(profiles).transform((row) =>
  storedProfileSchema.parse({ ...row, document: jsonSchema.parse(JSON.parse(row.document)) }),
);

const planRow = createSelectSchema(plans).transform((row) =>
  storedPlanSchema.parse({ ...row, document: jsonSchema.parse(JSON.parse(row.document)) }),
);

/** Options for {@link DrizzleStorage}. */
export interface DrizzleStorageOptions {
  /** Produces each new run and report id; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/**
 * {@link Storage} over a SQLite database reached through an {@link SqlExecutor}. Build one with {@link openDrizzleStorage}, which applies the migrations first.
 *
 * Calls are queued and run one at a time, so a multi-statement call such as `appendSamples` is never interleaved with another on the connection.
 */
export class DrizzleStorage implements Storage {
  private readonly db;
  private readonly newId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  /** Use {@link openDrizzleStorage}: this does not migrate the database. */
  constructor(execute: SqlExecutor, options: DrizzleStorageOptions = {}) {
    this.db = drizzle(proxyExecutors(execute));
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  }

  createRun(input: NewRun): Promise<Run> {
    return this.serial(async () => {
      const run: Run = { id: this.newId(), ...newRunSchema.parse(input), stoppedAt: null };
      await this.db.insert(runs).values(run);
      return run;
    });
  }

  stopRun(runId: string, stoppedAt: number): Promise<Run> {
    return this.serial(async () => {
      const run = await this.requireRun(runId);
      if (run.stoppedAt !== null) {
        throw new StorageError("conflict", `run ${runId} is already stopped`);
      }
      if (stoppedAt < run.startedAt) {
        throw new StorageError("invalid", `run ${runId} cannot stop before it started`);
      }
      await this.db.update(runs).set({ stoppedAt }).where(eq(runs.id, runId));
      return { ...run, stoppedAt };
    });
  }

  setRunNotes(runId: string, notes: string): Promise<Run> {
    return this.serial(async () => {
      const run = await this.requireRun(runId);
      await this.db.update(runs).set({ notes }).where(eq(runs.id, runId));
      return { ...run, notes };
    });
  }

  getRun(runId: string): Promise<Run | undefined> {
    return this.serial(() => this.findRun(runId));
  }

  listRuns(query: RunQuery = {}): Promise<Run[]> {
    return this.serial(async () => {
      const rows = await this.db
        .select()
        .from(runs)
        .where(
          and(
            query.profile === undefined ? undefined : eq(runs.profile, query.profile),
            query.origin === undefined ? undefined : eq(runs.origin, query.origin),
          ),
        )
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(query.limit ?? Number.MAX_SAFE_INTEGER)
        .offset(query.offset ?? 0);
      return rows.map((row) => runRow.parse(row));
    });
  }

  deleteRun(runId: string): Promise<void> {
    return this.serial(async () => {
      await this.db.delete(runs).where(eq(runs.id, runId));
    });
  }

  appendSamples(batch: readonly Sample[]): Promise<void> {
    return this.serial(async () => {
      const checked = batch.map((sample) => sampleSchema.parse(sample));
      const ids = [...new Set(checked.map((sample) => sample.runId))];
      if (ids.length === 0) return;
      const known = new Map(
        (
          await this.db
            .select({ id: runs.id, stoppedAt: runs.stoppedAt })
            .from(runs)
            .where(inArray(runs.id, ids))
        ).map((row) => [row.id, row.stoppedAt]),
      );
      for (const id of ids) {
        if (!known.has(id)) throw new StorageError("not-found", `no run ${id}`);
        if (known.get(id) !== null) {
          throw new StorageError("conflict", `run ${id} is stopped and takes no more samples`);
        }
      }
      await this.db.transaction(async (tx) => {
        for (let start = 0; start < checked.length; start += INSERT_ROWS) {
          await tx.insert(samples).values(
            checked.slice(start, start + INSERT_ROWS).map((sample) => ({
              runId: sample.runId,
              signal: sample.signal,
              unit: sample.unit,
              timestamp: sample.timestamp,
              valueNum: typeof sample.value === "number" ? sample.value : null,
              valueText: typeof sample.value === "string" ? sample.value : null,
            })),
          );
        }
      });
    });
  }

  readSamples(query: SampleQuery): Promise<Sample[]> {
    return this.serial(async () => {
      const rows = await this.db
        .select()
        .from(samples)
        .where(sampleFilter(query))
        .orderBy(asc(samples.timestamp), asc(samples.id))
        .limit(query.limit ?? Number.MAX_SAFE_INTEGER)
        .offset(query.offset ?? 0);
      return rows.map((row) => sampleRow.parse(row));
    });
  }

  aggregate(query: AggregateQuery): Promise<SignalAggregate[]> {
    return this.serial(async () => {
      const rows = await this.db
        .select({
          signal: samples.signal,
          unit: samples.unit,
          count: count(),
          numericCount: count(samples.valueNum),
          min: min(samples.valueNum),
          max: max(samples.valueNum),
          mean: avg(samples.valueNum).mapWith(Number),
          firstAt: min(samples.timestamp),
          lastAt: max(samples.timestamp),
        })
        .from(samples)
        .where(sampleFilter(query))
        .groupBy(samples.signal, samples.unit)
        .orderBy(asc(samples.signal), asc(samples.unit));
      return rows.map((row) => signalAggregateSchema.parse(row));
    });
  }

  saveScanReport(input: NewScanReport): Promise<ScanReport> {
    return this.serial(async () => {
      const report: ScanReport = { id: this.newId(), ...newScanReportSchema.parse(input) };
      await this.db
        .insert(scanReports)
        .values({ ...report, report: JSON.stringify(report.report) });
      return report;
    });
  }

  getScanReport(id: string): Promise<ScanReport | undefined> {
    return this.serial(async () => {
      const [row] = await this.db.select().from(scanReports).where(eq(scanReports.id, id));
      return row === undefined ? undefined : reportRow.parse(row);
    });
  }

  listScanReports(query: ScanReportQuery = {}): Promise<ScanReportSummary[]> {
    return this.serial(async () => {
      const rows = await this.db
        .select({
          id: scanReports.id,
          profile: scanReports.profile,
          adapter: scanReports.adapter,
          takenAt: scanReports.takenAt,
          label: scanReports.label,
          origin: scanReports.origin,
        })
        .from(scanReports)
        .where(
          and(
            query.profile === undefined ? undefined : eq(scanReports.profile, query.profile),
            query.origin === undefined ? undefined : eq(scanReports.origin, query.origin),
          ),
        )
        .orderBy(desc(scanReports.takenAt), desc(scanReports.id))
        .limit(query.limit ?? Number.MAX_SAFE_INTEGER)
        .offset(query.offset ?? 0);
      return rows.map((row) => scanReportSummarySchema.parse(row));
    });
  }

  deleteScanReport(id: string): Promise<void> {
    return this.serial(async () => {
      await this.db.delete(scanReports).where(eq(scanReports.id, id));
    });
  }

  saveProfile(profile: StoredProfile): Promise<{ readonly replaced: boolean }> {
    return this.serial(async () => {
      const checked = storedProfileSchema.parse(profile);
      const [existing] = await this.db
        .select({ name: profiles.name })
        .from(profiles)
        .where(eq(profiles.name, checked.name));
      const values = { ...checked, document: JSON.stringify(checked.document) };
      await this.db
        .insert(profiles)
        .values(values)
        .onConflictDoUpdate({ target: profiles.name, set: values });
      return { replaced: existing !== undefined };
    });
  }

  getProfile(name: string): Promise<StoredProfile | undefined> {
    return this.serial(async () => {
      const [row] = await this.db.select().from(profiles).where(eq(profiles.name, name));
      return row === undefined ? undefined : profileRow.parse(row);
    });
  }

  listProfiles(): Promise<StoredProfile[]> {
    return this.serial(async () => {
      const rows = await this.db.select().from(profiles).orderBy(asc(profiles.name));
      return rows.map((row) => profileRow.parse(row));
    });
  }

  savePlan(plan: StoredPlan): Promise<void> {
    return this.serial(async () => {
      const checked = storedPlanSchema.parse(plan);
      const values = { ...checked, document: JSON.stringify(checked.document) };
      await this.db
        .insert(plans)
        .values(values)
        .onConflictDoUpdate({ target: plans.id, set: values });
    });
  }

  getPlan(id: string): Promise<StoredPlan | undefined> {
    return this.serial(async () => {
      const [row] = await this.db.select().from(plans).where(eq(plans.id, id));
      return row === undefined ? undefined : planRow.parse(row);
    });
  }

  listPlans(): Promise<StoredPlan[]> {
    return this.serial(async () => {
      const rows = await this.db.select().from(plans).orderBy(desc(plans.updatedAt), asc(plans.id));
      return rows.map((row) => planRow.parse(row));
    });
  }

  deletePlan(id: string): Promise<void> {
    return this.serial(async () => {
      await this.db.delete(plans).where(eq(plans.id, id));
    });
  }

  saveCapture(capture: Capture, origin: Origin): Promise<CaptureSummary> {
    return this.serial(async () => {
      const summary = captureSummary(validateCapture(capture, "capture"), origin);
      const [existing] = await this.db
        .select({ id: captures.id })
        .from(captures)
        .where(eq(captures.id, summary.id));
      if (existing !== undefined) {
        throw new StorageError("conflict", `a capture ${summary.id} is stored already`);
      }
      await this.db.transaction(async (tx) => {
        await tx.insert(captures).values({
          id: summary.id,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          kind: summary.kind,
          profile: summary.profile,
          complete: summary.complete ? 1 : 0,
          description: summary.description,
          adapter: summary.adapter,
          exchanges: summary.exchanges,
          document: compressCapture(capture),
          origin: summary.origin,
        });
        for (let start = 0; start < summary.units.length; start += INSERT_ROWS) {
          await tx.insert(captureUnits).values(
            summary.units.slice(start, start + INSERT_ROWS).map((unit, offset) => ({
              captureId: summary.id,
              position: start + offset,
              ...unit,
            })),
          );
        }
      });
      return summary;
    });
  }

  getCapture(id: string): Promise<Capture | undefined> {
    return this.serial(async () => {
      const [row] = await this.db
        .select({ document: captures.document })
        .from(captures)
        .where(eq(captures.id, id));
      return row === undefined ? undefined : readCaptureFile(row.document, `stored capture ${id}`);
    });
  }

  listCaptures(query: CaptureQuery = {}): Promise<CaptureSummary[]> {
    return this.serial(async () => {
      const rows = await this.db
        .select({
          id: captures.id,
          startedAt: captures.startedAt,
          endedAt: captures.endedAt,
          kind: captures.kind,
          profile: captures.profile,
          complete: captures.complete,
          description: captures.description,
          adapter: captures.adapter,
          exchanges: captures.exchanges,
          origin: captures.origin,
        })
        .from(captures)
        .where(query.origin === undefined ? undefined : eq(captures.origin, query.origin))
        .orderBy(desc(captures.startedAt), desc(captures.id))
        .limit(query.limit ?? Number.MAX_SAFE_INTEGER)
        .offset(query.offset ?? 0);
      if (rows.length === 0) return [];
      const units = await this.db
        .select()
        .from(captureUnits)
        .where(
          inArray(
            captureUnits.captureId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(captureUnits.captureId), asc(captureUnits.position));
      return rows.map((row) =>
        captureSummarySchema.parse({
          ...row,
          complete: row.complete === 1,
          units: units
            .filter((unit) => unit.captureId === row.id)
            .map(({ address, label, exchanges, answered }) => ({
              address,
              label,
              exchanges,
              answered,
            })),
        }),
      );
    });
  }

  deleteCapture(id: string): Promise<void> {
    return this.serial(async () => {
      await this.db.delete(captures).where(eq(captures.id, id));
    });
  }

  /** Runs `work` after every earlier call has settled, whether it succeeded or not. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async findRun(runId: string): Promise<Run | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, runId));
    return row === undefined ? undefined : runRow.parse(row);
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.findRun(runId);
    if (run === undefined) throw new StorageError("not-found", `no run ${runId}`);
    return run;
  }
}

function sampleFilter(query: AggregateQuery): SQL | undefined {
  return and(
    eq(samples.runId, query.runId),
    query.signal === undefined ? undefined : eq(samples.signal, query.signal),
    query.from === undefined ? undefined : gte(samples.timestamp, query.from),
    query.to === undefined ? undefined : lt(samples.timestamp, query.to),
  );
}

/**
 * Applies any pending migrations through `execute` and returns the storage over it.
 *
 * @throws whatever the executor throws when a migration fails; the failed migration is rolled back.
 */
export async function openDrizzleStorage(
  execute: SqlExecutor,
  options: DrizzleStorageOptions = {},
): Promise<DrizzleStorage> {
  await applyMigrations(execute);
  return new DrizzleStorage(execute, options);
}
