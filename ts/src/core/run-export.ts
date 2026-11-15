/**
 * Exporting a stored run as CSV or JSON.
 *
 * The CSV has the layout of the live log the Python tool wrote: a `time` column (ISO 8601 with milliseconds, UTC), an `elapsed (s)` column counted from the run's start, then one column per signal titled `signal (unit)`, in the order the signals first appear. A row holds the readings that share a timestamp, and a signal with no reading there is left empty. It goes through {@link CsvLog}, so it is written the way every other log is. This module is platform-free.
 */

import { CsvLog, type CsvSink } from "./csvlog.js";
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

/** The JSON export of a run: the run record and every sample in time order. */
export const runExportSchema = z.object({
  format: z.literal("obd-read-run"),
  version: z.literal(1),
  run: runSchema,
  samples: z.array(sampleSchema),
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
 * A run and all its samples as one JSON-serialisable document.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunJson(storage: Storage, runId: string): Promise<RunExport> {
  const run = await loadRun(storage, runId);
  const samples: Sample[] = [];
  for await (const sample of samplesOf(storage, runId)) samples.push(sample);
  return { format: "obd-read-run", version: 1, run, samples };
}

function columnTitle(sample: Sample): string {
  return sample.unit === "" ? sample.signal : `${sample.signal} (${sample.unit})`;
}

/** A number to ten significant digits, as the Python log wrote it, or the text as it is. */
function cell(value: SampleValue): string {
  return typeof value === "string" ? value : String(Number(value.toPrecision(10)));
}

/**
 * Writes a run to `sink` as CSV, one row at a time, and closes the sink.
 *
 * Two readings of one signal at one timestamp go on separate rows with the same time, so none is lost.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunCsv(storage: Storage, runId: string, sink: CsvSink): Promise<void> {
  const run = await loadRun(storage, runId);
  const readings: { readonly sample: Sample; readonly column: number }[] = [];
  const columns = new Map<string, number>();
  for await (const sample of samplesOf(storage, runId)) {
    const title = columnTitle(sample);
    const column = columns.get(title) ?? columns.size;
    columns.set(title, column);
    readings.push({ sample, column });
  }
  const log = await CsvLog.create(sink, ["time", "elapsed (s)", ...columns.keys()]);
  let row: (string | undefined)[] = [];
  let rowTime: number | undefined;
  const flush = async (): Promise<void> => {
    if (rowTime === undefined) return;
    await log.write([
      new Date(rowTime).toISOString(),
      ((rowTime - run.startedAt) / 1000).toFixed(3),
      ...row.map((value) => value ?? ""),
    ]);
    row = [];
    rowTime = undefined;
  };
  for (const { sample, column } of readings) {
    if (rowTime !== sample.timestamp || row[column] !== undefined) await flush();
    if (rowTime === undefined) {
      rowTime = sample.timestamp;
      row = Array.from({ length: columns.size }, () => undefined);
    }
    row[column] = cell(sample.value);
  }
  await flush();
  await log.close();
}

/**
 * A run as CSV text, in the layout {@link exportRunCsv} writes.
 *
 * @throws StorageError `not-found` for an unknown run.
 */
export async function exportRunCsvText(storage: Storage, runId: string): Promise<string> {
  let text = "";
  await exportRunCsv(storage, runId, {
    write: (chunk) => {
      text += chunk;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  return text;
}
