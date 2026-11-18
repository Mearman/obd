/**
 * Exporting a stored run as CSV, TSV or JSON, and reading a CSV or TSV export back.
 *
 * The CSV has the layout of the live log the Python tool wrote: a `time` column (ISO 8601 with milliseconds, UTC), an `elapsed (s)` column counted from the run's start, then one column per signal titled `signal (unit)`, in the order the signals first appear. A row holds the readings that share a timestamp, and a signal with no reading there is left empty. It goes through {@link CsvLog}, so it is written the way every other log is, in either delimited dialect. The whole layout is {@link runTable}.
 *
 * A run's fault code changes ({@link faultEvents}) are exported beside the readings, never in their place: the JSON export lists them as `faultEvents`, and {@link runFaultEventTable} lays them out as a table of their own, timed like the readings table, while the readings table keeps each fault code list as the text column it records. This module is platform-free.
 */

import { CsvLog, type CsvSink } from "./csvlog.js";
import { faultEventSchema, faultEvents, type FaultEvent } from "./fault-history.js";
import { parseTable, type Dialect, type TableSpec } from "./tabular.js";
import {
  StorageError,
  runSchema,
  sampleSchema,
  type Run,
  type Sample,
  type SampleValue,
  type Storage,
} from "./storage.js";
import { z } from "zod";

/** The JSON export of a run: the run record, every sample in time order and the fault code changes those samples hold ({@link faultEvents}). An export written before runs recorded their origin, VIN or plate has none of that field, and one written before exports listed the fault code changes has no `faultEvents`. */
export const runExportSchema = z.object({
  format: z.literal("obd-read-run"),
  version: z.literal(1),
  run: runSchema.partial({ origin: true, vin: true, plate: true }),
  samples: z.array(sampleSchema),
  faultEvents: z.array(faultEventSchema).optional(),
});

/** The JSON export of a run. */
export type RunExport = z.output<typeof runExportSchema>;

/** How many samples are read from storage at a time while exporting. */
const PAGE = 5000;

async function loadRun(storage: Storage, runId: string): Promise<Run> {
  const run = await storage.getRun(runId);
  if (run === undefined) throw new StorageError("not-found", `no run ${runId}`);
  return run;
}

async function* samplesOf(storage: Storage, runId: string): AsyncGenerator<Sample> {
  for (let offset = 0; ; offset += PAGE) {
    const samples = await storage.readSamples({ runId, limit: PAGE, offset });
    yield* samples;
    if (samples.length < PAGE) return;
  }
}

/**
 * A run, all its samples and its fault code changes as one JSON-serialisable document.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunJson(
  storage: Storage,
  runId: string,
): Promise<RunExport & { readonly run: Run; readonly faultEvents: FaultEvent[] }> {
  const run = await loadRun(storage, runId);
  const samples: Sample[] = [];
  for await (const sample of samplesOf(storage, runId)) samples.push(sample);
  return { format: "obd-read-run", version: 1, run, samples, faultEvents: faultEvents(samples) };
}

function columnTitle(sample: Pick<Sample, "signal" | "unit">): string {
  return sample.unit === "" ? sample.signal : `${sample.signal} (${sample.unit})`;
}

/** A number to ten significant digits, as the Python log wrote it, or the text as it is. */
function cell(value: SampleValue): string {
  return typeof value === "string" ? value : String(Number(value.toPrecision(10)));
}

/** The two columns every run table starts with, before one column per signal. */
export const RUN_FIXED_COLUMNS = ["time", "elapsed (s)"] as const;

/** An instant as the run tables write it: ISO 8601 with milliseconds, UTC. */
function timeCell(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/** Seconds since the run's start to the millisecond, as the run tables write them. */
function elapsedCell(startedAt: number, timestamp: number): string {
  return ((timestamp - startedAt) / 1000).toFixed(3);
}

/**
 * The table of a run's fault code changes: {@link RUN_FIXED_COLUMNS}, written as the readings table writes them, then `list` (`stored`, `pending` or `permanent`), `code`, `change` (`appeared` or `disappeared`) and `at start` (`yes` for a code present at the first poll of its list, else `no`). One row per {@link FaultEvent}, in the order given.
 *
 * @param startedAt The run's start, which `elapsed (s)` counts from.
 */
export function runFaultEventTable(startedAt: number): TableSpec<FaultEvent> {
  return {
    columns: [
      { header: RUN_FIXED_COLUMNS[0], cell: (event) => timeCell(event.timestamp) },
      { header: RUN_FIXED_COLUMNS[1], cell: (event) => elapsedCell(startedAt, event.timestamp) },
      { header: "list", cell: (event) => event.list },
      { header: "code", cell: (event) => event.code },
      { header: "change", cell: (event) => event.change },
      { header: "at start", cell: (event) => (event.atStart ? "yes" : "no") },
    ],
  };
}

/** A run's readings laid out as a table: the header, then one row per timestamp. */
export interface RunTable {
  readonly header: string[];
  readonly rows: string[][];
}

/**
 * The layout of a run's table: {@link RUN_FIXED_COLUMNS}, then one column per signal titled `signal (unit)` (or `signal` when it has no unit) in the order the signals first appear. A row holds the readings that share a timestamp, and a signal with no reading there is left empty. Two readings of one signal at one timestamp go on separate rows with the same time, so none is lost.
 *
 * `samples` are in time order.
 */
export function runTable(startedAt: number, samples: readonly Sample[]): RunTable {
  const columns = new Map<string, number>();
  const readings = samples.map((sample) => {
    const title = columnTitle(sample);
    const column = columns.get(title) ?? columns.size;
    columns.set(title, column);
    return { sample, column };
  });
  const rows: string[][] = [];
  let row: (string | undefined)[] = [];
  let rowTime: number | undefined;
  const flush = (): void => {
    if (rowTime === undefined) return;
    rows.push([
      timeCell(rowTime),
      elapsedCell(startedAt, rowTime),
      ...row.map((value) => value ?? ""),
    ]);
    row = [];
    rowTime = undefined;
  };
  for (const { sample, column } of readings) {
    if (rowTime !== sample.timestamp || row[column] !== undefined) flush();
    if (rowTime === undefined) {
      rowTime = sample.timestamp;
      row = Array.from({ length: columns.size }, () => undefined);
    }
    row[column] = cell(sample.value);
  }
  flush();
  return { header: [...RUN_FIXED_COLUMNS, ...columns.keys()], rows };
}

/**
 * Writes a run to `sink` as CSV or TSV, one row at a time, and closes the sink.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunDelimited(
  storage: Storage,
  runId: string,
  sink: CsvSink,
  dialect: Dialect,
): Promise<void> {
  const run = await loadRun(storage, runId);
  const samples: Sample[] = [];
  for await (const sample of samplesOf(storage, runId)) samples.push(sample);
  const table = runTable(run.startedAt, samples);
  const log = await CsvLog.create(sink, table.header, dialect);
  for (const row of table.rows) await log.write(row);
  await log.close();
}

/**
 * A run as CSV or TSV text, in the layout {@link exportRunDelimited} writes.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunDelimitedText(
  storage: Storage,
  runId: string,
  dialect: Dialect,
): Promise<string> {
  let text = "";
  await exportRunDelimited(
    storage,
    runId,
    {
      write: (chunk) => {
        text += chunk;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    dialect,
  );
  return text;
}

/** A run's CSV or TSV export that cannot be read back as a run. */
export class RunImportError extends Error {
  override name = "RunImportError";
}

/** The readings of an imported run and when it started. */
export interface ParsedRun {
  readonly startedAt: number;
  readonly samples: readonly Omit<Sample, "runId">[];
}

/** An ISO 8601 instant in UTC: seconds, optional fractional seconds, and `Z` or a zero offset (`+00:00`, `-00:00`, `+0000` or `+00`). The app writes `Z` and the command line `+00:00`. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]00(?::?00)?)$/;
const NUMBER = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/** A title as {@link columnTitle} writes it, back to the signal and its unit. A signal whose own name ends in a parenthesised word and has no unit reads back with that word as the unit. */
function titleParts(title: string): { readonly signal: string; readonly unit: string } {
  const match = /^(.+) \(([^()]*)\)$/.exec(title);
  return match?.[1] === undefined || match[2] === undefined
    ? { signal: title, unit: "" }
    : { signal: match[1], unit: match[2] };
}

function dialectOf(text: string): Dialect {
  return text.replace(/^\uFEFF/, "").startsWith(`${RUN_FIXED_COLUMNS[0]}\t`) ? "tsv" : "csv";
}

/**
 * Reads a run's CSV or TSV export (the layout of {@link runTable}) back into its readings, in the dialect the first header column says: a header starting `time<TAB>` is TSV, any other CSV.
 *
 * A cell that is a plain number (digits, an optional fraction and exponent) is a number and any other text a string, so a text reading that looks like a number comes back as one. The run starts at the first row's time less its elapsed seconds.
 *
 * @throws RunImportError naming the first column that is not the writer's header, a row of the wrong width, a time that is not an ISO 8601 UTC instant or an elapsed value that is not a number of seconds, or a file with no rows.
 * @throws TabularError for text that is not valid in its dialect.
 */
export function parseRunTable(text: string): ParsedRun {
  const records = parseTable(dialectOf(text), text);
  const [header, ...rows] = records;
  if (header === undefined) throw new RunImportError("the file is empty");
  RUN_FIXED_COLUMNS.forEach((expected, index) => {
    const found = header[index];
    if (found !== expected) {
      throw new RunImportError(
        `column ${String(index + 1)} of the header is ${found === undefined ? "missing" : `"${found}"`} and a run export has "${expected}" there`,
      );
    }
  });
  const signals = header.slice(RUN_FIXED_COLUMNS.length).map((title, index) => {
    const column = RUN_FIXED_COLUMNS.length + index + 1;
    if (title === "") throw new RunImportError(`column ${String(column)} of the header is empty`);
    const first = header.indexOf(title);
    if (first !== column - 1) {
      throw new RunImportError(
        `column ${String(column)} of the header repeats column ${String(first + 1)}, "${title}"`,
      );
    }
    return titleParts(title);
  });
  let startedAt: number | undefined;
  const samples: Omit<Sample, "runId">[] = [];
  rows.forEach((row, index) => {
    const line = index + 2;
    if (row.length !== header.length) {
      throw new RunImportError(
        `row ${String(line)} has ${String(row.length)} columns and the header has ${String(header.length)}`,
      );
    }
    const [time = "", elapsed = ""] = row;
    const timestamp = Date.parse(time);
    if (!ISO_TIME.test(time) || Number.isNaN(timestamp)) {
      throw new RunImportError(
        `row ${String(line)} has the time "${time}", which is not an ISO 8601 UTC time (such as 2026-11-15T10:00:00.000Z or 2026-11-15T10:00:00.000+00:00)`,
      );
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(elapsed)) {
      throw new RunImportError(
        `row ${String(line)} has the elapsed time "${elapsed}", which is not a number of seconds`,
      );
    }
    startedAt ??= Math.round(timestamp - Number(elapsed) * 1000);
    signals.forEach(({ signal, unit }, column) => {
      const value = row[RUN_FIXED_COLUMNS.length + column];
      if (value === undefined || value === "") return;
      samples.push({ signal, unit, timestamp, value: NUMBER.test(value) ? Number(value) : value });
    });
  });
  if (startedAt === undefined) throw new RunImportError("the file has a header and no rows");
  return { startedAt, samples };
}

/** What an imported run is recorded under, as the file does not say. */
export interface ImportedRunDetails {
  readonly profile: string;
  readonly adapter: string;
  readonly notes: string;
}

/**
 * Stores a run read from a CSV or TSV export with the origin `imported`, stopped at its last reading. Nothing is stored when a reading is refused.
 *
 * @throws RunImportError or TabularError as {@link parseRunTable} does, and StorageError from storage.
 */
export async function importRunTable(
  storage: Storage,
  text: string,
  details: ImportedRunDetails,
): Promise<Run> {
  const parsed = parseRunTable(text);
  const run = await storage.createRun({
    ...details,
    startedAt: parsed.startedAt,
    origin: "imported",
  });
  try {
    await storage.appendSamples(parsed.samples.map((sample) => ({ ...sample, runId: run.id })));
    const stoppedAt = Math.max(
      parsed.startedAt,
      ...parsed.samples.map((sample) => sample.timestamp),
    );
    return await storage.stopRun(run.id, stoppedAt);
  } catch (error) {
    await storage.deleteRun(run.id);
    throw error;
  }
}

/**
 * The JSON-export document of a run read from a CSV or TSV export, for the commands that take a run's JSON export (sharing).
 *
 * @throws RunImportError or TabularError as {@link parseRunTable} does.
 */
export function runTableDocument(text: string, details: ImportedRunDetails): RunExport {
  const parsed = parseRunTable(text);
  const stoppedAt = Math.max(parsed.startedAt, ...parsed.samples.map((sample) => sample.timestamp));
  const samples = parsed.samples.map((sample) => ({ ...sample, runId: "imported" }));
  return {
    format: "obd-read-run",
    version: 1,
    run: { id: "imported", ...details, startedAt: parsed.startedAt, stoppedAt, origin: "imported" },
    samples,
    faultEvents: faultEvents(samples),
  };
}
