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
 *
 * Each {@link RunSeriesReader.read} reads on from where the last one stopped, so the graphs of a run still collecting follow it without reading its samples again. The time axis starts at the first reading and ends at the newest one read. Samples come back in time order, then in the order they were stored, so the read resumes at the last time it saw, past the samples it already holds there: the rest of a cycle whose readings share a time can be stored after a read.
 */
export class RunSeriesReader {
  readonly #client: DiagnosticsClient;
  readonly #run: Run;
  readonly #book: SeriesBook = new Map();
  #textReadings = 0;
  /** The first reading's time, which the axis counts from; undefined until a sample has been read. */
  #origin: number | undefined;
  /** The newest time read and how many samples at that time have been read; undefined until a sample has been read. */
  #last: { readonly timestamp: number; readonly count: number } | undefined;

  constructor(client: DiagnosticsClient, run: Run) {
    this.#client = client;
    this.#run = run;
  }

  /** Reads every sample stored since the last read and returns the whole run's series so far, as new arrays each time. */
  async read(): Promise<RunSeries> {
    const runId = this.#run.id;
    for (;;) {
      const last = this.#last;
      const page = await this.#client.runs.samples({
        runId,
        limit: SAMPLE_PAGE,
        ...(last === undefined ? {} : { from: last.timestamp, offset: last.count }),
      });
      const first = page[0];
      if (first === undefined) break;
      this.#origin ??= first.timestamp;
      this.#textReadings += foldSamples(this.#book, page, this.#origin, POINTS_PER_SERIES);
      for (const { timestamp } of page) {
        this.#last =
          this.#last?.timestamp === timestamp
            ? { timestamp, count: this.#last.count + 1 }
            : { timestamp, count: 1 };
      }
      if (page.length < SAMPLE_PAGE) break;
    }
    const summaries = new Map<string, SeriesSummary>();
    for (const aggregate of await this.#client.runs.aggregate({ runId })) {
      summaries.set(`${aggregate.signal}\u0000${aggregate.unit}`, {
        readings: aggregate.count,
        min: aggregate.min,
        max: aggregate.max,
      });
    }
    const span =
      this.#origin === undefined || this.#last === undefined
        ? 0
        : this.#last.timestamp - this.#origin;
    return {
      // Copied, because the book's points grow in place and a chart redraws only for new arrays.
      series: seriesOf(this.#book).map((series) => ({ ...series, points: [...series.points] })),
      summaries,
      domain: [0, Math.max(1, span)],
      textReadings: this.#textReadings,
    };
  }
}
