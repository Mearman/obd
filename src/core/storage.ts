/**
 * The storage contract: collection runs, their samples, saved scan reports and imported profiles.
 *
 * Everything crossing this interface is plain, serialisable data described by a Zod schema, so an implementation can sit behind a worker or a socket as easily as in the same process. This module is platform-free; the in-memory implementation lives in `testing/memory-storage.ts`, and the SQLite implementation (Drizzle over an injected SQL executor) in `src/storage/`.
 *
 * Times are integer milliseconds since the Unix epoch, supplied by the caller so storage never reads a clock.
 */

import { z } from "zod";

/** A time as integer milliseconds since the Unix epoch. */
const timestampSchema = z.number().int().nonnegative();

/** A non-empty identifier or label. */
const nameSchema = z.string().min(1);

/** A page size: a positive whole number of records. */
const limitSchema = z.number().int().positive();

/** A count of records to skip. */
const offsetSchema = z.number().int().nonnegative();

/** One collection run: a period during which a profile's signals were polled through one adapter. */
export const runSchema = z.object({
  /** Assigned by storage when the run is created. */
  id: nameSchema,
  /** The name of the profile the run collected for, or `generic-obd2` for a run with no profile. */
  profile: nameSchema,
  /** The adapter's URL or label, as the user chose it. */
  adapter: nameSchema,
  startedAt: timestampSchema,
  /** `null` while the run is open. */
  stoppedAt: timestampSchema.nullable(),
  notes: z.string(),
});

/** A collection run. */
export type Run = z.output<typeof runSchema>;

/** What a caller supplies to open a run; storage assigns the id and leaves it open. */
export const newRunSchema = z.object({
  profile: nameSchema,
  adapter: nameSchema,
  startedAt: timestampSchema,
  notes: z.string().default(""),
});

/** The fields a caller gives to {@link Storage.createRun}. */
export type NewRun = z.input<typeof newRunSchema>;

/** A reading's value: a finite number, or text for a value that is not numeric. */
export const sampleValueSchema = z.union([z.number(), z.string()]);

/** A reading's value. */
export type SampleValue = z.output<typeof sampleValueSchema>;

/** One reading of one signal at one time within a run. */
export const sampleSchema = z.object({
  runId: nameSchema,
  /** The signal's stable identifier, such as a profile value name. */
  signal: nameSchema,
  /** The unit the value is in; empty for a unitless value. */
  unit: z.string(),
  timestamp: timestampSchema,
  value: sampleValueSchema,
});

/** One reading of one signal at one time within a run. */
export type Sample = z.output<typeof sampleSchema>;

/** The runs {@link Storage.listRuns} returns, newest first. */
export const runQuerySchema = z.object({
  /** Only runs collected for this profile. */
  profile: nameSchema.optional(),
  limit: limitSchema.optional(),
  offset: offsetSchema.optional(),
});

/** Filters for {@link Storage.listRuns}. */
export type RunQuery = z.output<typeof runQuerySchema>;

/** The time range and signal a sample read or aggregate covers. */
const rangeShape = {
  runId: nameSchema,
  /** Only this signal. */
  signal: nameSchema.optional(),
  /** Only samples at or after this time. */
  from: timestampSchema.optional(),
  /** Only samples strictly before this time, so adjacent ranges never share a sample. */
  to: timestampSchema.optional(),
};

/** Which of a run's samples {@link Storage.readSamples} returns, in time order. */
export const sampleQuerySchema = z.object({
  ...rangeShape,
  limit: limitSchema.optional(),
  offset: offsetSchema.optional(),
});

/** Filters for {@link Storage.readSamples}: samples are ordered by time, then by the order they were stored. */
export type SampleQuery = z.output<typeof sampleQuerySchema>;

/** Which of a run's samples {@link Storage.aggregate} summarises. */
export const aggregateQuerySchema = z.object(rangeShape);

/** Filters for {@link Storage.aggregate}. */
export type AggregateQuery = z.output<typeof aggregateQuerySchema>;

/**
 * A summary of one signal in one unit over the samples a query selects.
 *
 * `min`, `max` and `mean` cover the numeric samples only and are `null` when there are none.
 */
export const signalAggregateSchema = z.object({
  signal: nameSchema,
  unit: z.string(),
  /** Every sample, numeric or text. */
  count: z.number().int().nonnegative(),
  numericCount: z.number().int().nonnegative(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
  firstAt: timestampSchema,
  lastAt: timestampSchema,
});

/** A summary of one signal in one unit. */
export type SignalAggregate = z.output<typeof signalAggregateSchema>;

/** Any JSON document: what a saved scan report and an imported profile are stored as. */
export const jsonSchema = z.json();

/** A JSON value. */
export type Json = z.output<typeof jsonSchema>;

/** What a caller gives to save a scan report. */
export const newScanReportSchema = z.object({
  profile: nameSchema,
  adapter: nameSchema,
  takenAt: timestampSchema,
  /** A short name the user gave the report; may be empty. */
  label: z.string().default(""),
  /** The report as `scan --output` writes it, so a saved scan compares and describes unchanged. */
  report: jsonSchema,
});

/** The fields a caller gives to {@link Storage.saveScanReport}. */
export type NewScanReport = z.input<typeof newScanReportSchema>;

/** A saved scan report with its id; the report itself is read separately. */
export const scanReportSummarySchema = z.object({
  id: nameSchema,
  profile: nameSchema,
  adapter: nameSchema,
  takenAt: timestampSchema,
  label: z.string(),
});

/** A saved scan report without its body. */
export type ScanReportSummary = z.output<typeof scanReportSummarySchema>;

/** A saved scan report. */
export const scanReportSchema = scanReportSummarySchema.extend({ report: jsonSchema });

/** A saved scan report with its body. */
export type ScanReport = z.output<typeof scanReportSchema>;

/** Which saved scan reports {@link Storage.listScanReports} returns, newest first. */
export const scanReportQuerySchema = z.object({
  profile: nameSchema.optional(),
  limit: limitSchema.optional(),
  offset: offsetSchema.optional(),
});

/** Filters for {@link Storage.listScanReports}. */
export type ScanReportQuery = z.output<typeof scanReportQuerySchema>;

/** A profile document the user imported, kept so it survives a reload. */
export const storedProfileSchema = z.object({
  /** The profile's own name; importing a second profile with the same name replaces the first. */
  name: nameSchema,
  importedAt: timestampSchema,
  /** The profile JSON, validated by `parseProfile` before it is stored. */
  document: jsonSchema,
});

/** An imported profile. */
export type StoredProfile = z.output<typeof storedProfileSchema>;

/** Why a storage call failed. */
export type StorageErrorCode =
  /** The run, report or profile named does not exist. */
  | "not-found"
  /** The call conflicts with the record's state, such as stopping a run twice. */
  | "conflict"
  /** An argument is outside what storage accepts, such as a stop time before the start. */
  | "invalid";

/** A storage call failed for a reason the caller can act on; `code` says which. */
export class StorageError extends Error {
  override name = "StorageError";

  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Durable storage for runs, samples, scan reports and imported profiles.
 *
 * Every method is async and takes and returns only plain data. Implementations reject with {@link StorageError} for a caller's mistake and with whatever the backing store throws otherwise. Calls on one instance behave as if run one at a time in the order made.
 */
export interface Storage {
  /** Opens a run and returns it with its assigned id. */
  createRun(input: NewRun): Promise<Run>;

  /**
   * Closes a run at `stoppedAt`.
   *
   * @throws StorageError `not-found` for an unknown run, `conflict` when it is already stopped, `invalid` when `stoppedAt` precedes the start.
   */
  stopRun(runId: string, stoppedAt: number): Promise<Run>;

  /**
   * Replaces a run's notes.
   *
   * @throws StorageError `not-found` for an unknown run.
   */
  setRunNotes(runId: string, notes: string): Promise<Run>;

  /** The run with this id, or `undefined`. */
  getRun(runId: string): Promise<Run | undefined>;

  /** Runs matching the query, newest first by start time. */
  listRuns(query?: RunQuery): Promise<Run[]>;

  /** Removes a run and its samples. Removing an unknown run does nothing. */
  deleteRun(runId: string): Promise<void>;

  /**
   * Stores samples atomically: either all are stored or none.
   *
   * @throws StorageError `not-found` when a sample names an unknown run, `conflict` when it names a stopped run, `invalid` for a non-finite number.
   */
  appendSamples(samples: readonly Sample[]): Promise<void>;

  /** A run's samples in time order, then in the order they were stored. */
  readSamples(query: SampleQuery): Promise<Sample[]>;

  /** One summary per signal and unit among the selected samples, ordered by signal then unit. */
  aggregate(query: AggregateQuery): Promise<SignalAggregate[]>;

  /** Stores a scan report and returns it with its assigned id. */
  saveScanReport(input: NewScanReport): Promise<ScanReport>;

  /** The scan report with this id, or `undefined`. */
  getScanReport(id: string): Promise<ScanReport | undefined>;

  /** Saved reports without their bodies, newest first by time taken. */
  listScanReports(query?: ScanReportQuery): Promise<ScanReportSummary[]>;

  /** Removes a scan report. Removing an unknown report does nothing. */
  deleteScanReport(id: string): Promise<void>;

  /**
   * Stores an imported profile, replacing any of the same name.
   *
   * @returns Whether a profile of that name was replaced.
   */
  saveProfile(profile: StoredProfile): Promise<{ readonly replaced: boolean }>;

  /** The imported profile with this name, or `undefined`. */
  getProfile(name: string): Promise<StoredProfile | undefined>;

  /** Every imported profile, ordered by name. */
  listProfiles(): Promise<StoredProfile[]>;
}
