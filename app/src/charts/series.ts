/** One numeric reading: `t` is a time on the chart's axis (milliseconds from the run's start) and `v` its value. */
export interface Point {
  readonly t: number;
  readonly v: number;
}

/** The smallest and largest value of a series. */
export interface Extent {
  readonly min: number;
  readonly max: number;
}

/** The viewBox of every chart: a unit square scaled by CSS, so text and strokes stay crisp at any width. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 100;

/**
 * The smallest and largest value of `points`, or undefined when there are none.
 */
export function extentOf(points: readonly Point[]): Extent | undefined {
  const [first] = points;
  if (first === undefined) return undefined;
  let min = first.v;
  let max = first.v;
  for (const { v } of points) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Where `value` falls between `low` and `high`, from 0 to 1. A range with no width (a flat line, a single reading) maps to the middle, so a constant signal draws as a centred line instead of dividing by zero.
 */
export function fraction(value: number, low: number, high: number): number {
  if (high <= low) return 0.5;
  return (value - low) / (high - low);
}

/**
 * Thins `points` to at most `limit` points while keeping the extremes: the series is split into equal runs of readings and each run keeps its smallest and largest value, in time order, so a spike or a dip survives however long the run is. A series already within `limit` is returned as it is.
 *
 * `limit` is a whole number of at least 2.
 */
export function downsample(points: readonly Point[], limit: number): readonly Point[] {
  if (points.length <= limit) return points;
  const buckets = Math.max(1, Math.floor(limit / 2));
  const size = points.length / buckets;
  const kept: Point[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const slice = points.slice(Math.floor(bucket * size), Math.floor((bucket + 1) * size));
    const [first] = slice;
    if (first === undefined) continue;
    let low = first;
    let high = first;
    for (const point of slice) {
      if (point.v < low.v) low = point;
      if (point.v > high.v) high = point;
    }
    if (low === high) kept.push(low);
    else kept.push(...(low.t <= high.t ? [low, high] : [high, low]));
  }
  return kept;
}

/**
 * The index of the last point at or before `time`, or -1 when `time` is before the first. `points` are in time order.
 */
export function indexAtOrBefore(points: readonly Point[], time: number): number {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (point !== undefined && point.t <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The reading in force at `time`: the latest one at or before it, since a sampled signal holds its value until the next reading. Undefined before the first reading.
 */
export function valueAt(points: readonly Point[], time: number): Point | undefined {
  return points[indexAtOrBefore(points, time)];
}

/**
 * The time of the reading after (`direction` 1) or before (-1) `time`, or the end it runs out at when there is none. Undefined for a series with no readings.
 */
export function stepTime(
  points: readonly Point[],
  time: number,
  direction: 1 | -1,
): number | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const before = indexAtOrBefore(points, time);
  if (direction === 1) return (points[before + 1] ?? last).t;
  const at = points[before];
  if (at !== undefined && at.t < time) return at.t;
  return (points[before - 1] ?? first).t;
}

/**
 * The vertices of a polyline for `points` in the chart's viewBox: time maps across `domain`, the value across `range`, and a larger value is nearer the top.
 */
export function polyline(
  points: readonly Point[],
  domain: readonly [number, number],
  range: Extent,
): string {
  return points
    .map(({ t, v }) => {
      const x = fraction(t, domain[0], domain[1]) * VIEW_WIDTH;
      const y = (1 - fraction(v, range.min, range.max)) * VIEW_HEIGHT;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Formats a time since the start as `m:ss.s`, or `h:mm:ss.s` from an hour. */
export function formatElapsed(milliseconds: number): string {
  const tenths = Math.round(Math.max(0, milliseconds) / 100);
  const seconds = Math.floor(tenths / 10) % 60;
  const minutes = Math.floor(tenths / 600) % 60;
  const hours = Math.floor(tenths / 36000);
  const fractionDigit = tenths % 10;
  const tail = `${String(seconds).padStart(2, "0")}.${String(fractionDigit)}`;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${tail}`
    : `${String(minutes)}:${tail}`;
}

/** Formats a reading with up to three significant decimals and no trailing zeros. */
export function formatValue(value: number): string {
  return String(Number(value.toFixed(Math.abs(value) >= 100 ? 1 : 3)));
}

/** A signal's readings, ready to draw. */
export interface Series {
  /** Names the series within a run: the signal and its unit. */
  readonly key: string;
  readonly signal: string;
  readonly unit: string;
  readonly points: readonly Point[];
}

/**
 * Text that stands in for a chart: what it shows, its range and its first and last readings, so it can be read without seeing the line.
 */
export function describeSeries(
  name: string,
  unit: string,
  points: readonly Point[],
  elapsed: (milliseconds: number) => string = formatElapsed,
): string {
  const extent = extentOf(points);
  const first = points[0];
  const last = points[points.length - 1];
  if (extent === undefined || first === undefined || last === undefined) {
    return `${name}: no readings.`;
  }
  const withUnit = (value: number): string =>
    unit === "" ? formatValue(value) : `${formatValue(value)} ${unit}`;
  return `${name}: ${String(points.length)} readings from ${elapsed(first.t)} to ${elapsed(last.t)}, lowest ${withUnit(extent.min)}, highest ${withUnit(extent.max)}, starting at ${withUnit(first.v)} and ending at ${withUnit(last.v)}.`;
}

/** The series of a run being read: points by series key, in time order within each. */
export type SeriesBook = Map<string, { signal: string; unit: string; points: Point[] }>;

/**
 * Adds numeric `samples` (in time order, times already measured from the start of the axis) to `book`, and thins any series that has grown past twice `limit` back to `limit`, so reading a run of any length holds at most about twice `limit` points per series. Text readings are skipped and counted in the return value.
 */
export function foldSamples(
  book: SeriesBook,
  samples: readonly {
    readonly signal: string;
    readonly unit: string;
    readonly timestamp: number;
    readonly value: number | string;
  }[],
  origin: number,
  limit: number,
): number {
  let skipped = 0;
  const touched = new Set<string>();
  for (const sample of samples) {
    if (typeof sample.value !== "number") {
      skipped += 1;
      continue;
    }
    const key = `${sample.signal}\u0000${sample.unit}`;
    let entry = book.get(key);
    if (entry === undefined) {
      entry = { signal: sample.signal, unit: sample.unit, points: [] };
      book.set(key, entry);
    }
    entry.points.push({ t: sample.timestamp - origin, v: sample.value });
    touched.add(key);
  }
  for (const key of touched) {
    const entry = book.get(key);
    if (entry !== undefined && entry.points.length > limit * 2) {
      entry.points = [...downsample(entry.points, limit)];
    }
  }
  return skipped;
}

/** The series in `book`, ordered by signal then unit. */
export function seriesOf(book: SeriesBook): readonly Series[] {
  return [...book.entries()]
    .sort(([, a], [, b]) => a.signal.localeCompare(b.signal) || a.unit.localeCompare(b.unit))
    .map(([key, { signal, unit, points }]) => ({ key, signal, unit, points }));
}

/** The readings kept per signal for a rolling trend, keyed by signal. */
export type RollingHistory = ReadonlyMap<string, readonly Point[]>;

/**
 * Adds the newest reading of each signal in `latest` to `history`, keeping the last `limit` readings per signal, so a trend of live values holds a bounded amount however long the run goes on. A reading no newer than the last one kept (the same reading seen again) and a text reading are ignored.
 */
export function appendRolling(
  history: RollingHistory,
  latest: readonly {
    readonly signal: string;
    readonly timestamp: number;
    readonly value: number | string;
  }[],
  limit: number,
): RollingHistory {
  const next = new Map(history);
  for (const { signal, timestamp, value } of latest) {
    if (typeof value !== "number") continue;
    const kept = next.get(signal) ?? [];
    const newest = kept[kept.length - 1];
    if (newest !== undefined && newest.t >= timestamp) continue;
    next.set(signal, [...kept, { t: timestamp, v: value }].slice(-limit));
  }
  return next;
}
