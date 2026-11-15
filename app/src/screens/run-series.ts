import type { Run } from "obd-read";
import type { DiagnosticsClient } from "../diagnostics/client";
import { foldSamples, seriesOf, type Series, type SeriesBook } from "../charts";

/** How many samples one read of a run's samples asks for. */
export const SAMPLE_PAGE = 5000;

/** The most points a chart keeps per signal, however long the run is. A spike or dip is kept through the thinning. */
export const POINTS_PER_SERIES = 600;

/** One signal's whole-run summary, from the service's aggregate. */
export interface SeriesSummary {
  readonly readings: number;
  readonly min: number | null;
  readonly max: number | null;
}

/** A run's readings, ready to chart. */
export interface RunSeries {
  readonly series: readonly Series[];
  /** The whole-run summary of each series, by its key. */
  readonly summaries: ReadonlyMap<string, SeriesSummary>;
  /** The shared time axis in milliseconds from the first reading. */
  readonly domain: readonly [number, number];
  /** Readings that are text, so cannot be charted. */
  readonly textReadings: number;
}

/**
 * Reads a run's samples through the service a page at a time and folds each page into thinned series, so memory holds at most a bounded number of points per signal however many samples are stored. The summaries (count, lowest, highest) come from the service's aggregate and cover every sample, not only the points kept.
 */
export async function loadRunSeries(client: DiagnosticsClient, run: Run): Promise<RunSeries> {
  const aggregates = await client.runs.aggregate({ runId: run.id });
  if (aggregates.length === 0) {
    return { series: [], summaries: new Map(), domain: [0, 1], textReadings: 0 };
  }
  const origin = Math.min(...aggregates.map((aggregate) => aggregate.firstAt));
  const end = Math.max(...aggregates.map((aggregate) => aggregate.lastAt));
  const book: SeriesBook = new Map();
  let textReadings = 0;
  for (let offset = 0; ; offset += SAMPLE_PAGE) {
    const page = await client.runs.samples({ runId: run.id, limit: SAMPLE_PAGE, offset });
    textReadings += foldSamples(book, page, origin, POINTS_PER_SERIES);
    if (page.length < SAMPLE_PAGE) break;
  }
  const summaries = new Map<string, SeriesSummary>();
  for (const aggregate of aggregates) {
    summaries.set(`${aggregate.signal}\u0000${aggregate.unit}`, {
      readings: aggregate.count,
      min: aggregate.min,
      max: aggregate.max,
    });
  }
  return {
    series: seriesOf(book),
    summaries,
    domain: [0, Math.max(1, end - origin)],
    textReadings,
  };
}
