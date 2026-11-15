import type { ExchangeStatus, Timeline } from "obd-read";

/** The most cells a timeline strip draws, however long the capture, so drawing it never grows with the capture. */
export const MAX_STRIP_CELLS = 120;

/** One cell of the strip: a run of consecutive exchanges and the worst way any of them ended. */
export interface StripCell {
  /** The first exchange of the run, as an index into the timeline. */
  readonly from: number;
  /** One past the last exchange of the run. */
  readonly to: number;
  readonly status: ExchangeStatus;
}

const SEVERITY: Readonly<Record<ExchangeStatus, number>> = {
  answered: 0,
  negative: 1,
  unanswered: 2,
};

/** The timeline's exchanges grouped into at most `cells` runs of near-equal length, in order, each marked by its worst outcome (unanswered, then refused, then answered). */
export function stripCells(timeline: Timeline, cells = MAX_STRIP_CELLS): readonly StripCell[] {
  const total = timeline.entries.length;
  const count = Math.min(total, cells);
  const result: StripCell[] = [];
  for (let cell = 0; cell < count; cell += 1) {
    const from = Math.floor((cell * total) / count);
    const to = Math.floor(((cell + 1) * total) / count);
    let status: ExchangeStatus = "answered";
    for (let index = from; index < to; index += 1) {
      const entry = timeline.entries[index];
      if (entry !== undefined && SEVERITY[entry.status] > SEVERITY[status]) status = entry.status;
    }
    result.push({ from, to, status });
  }
  return result;
}

/** The index of the nearest exchange after `after` (or before it, going `backwards`) that was refused or unanswered, or `undefined` when there is none. */
export function nextIssue(
  timeline: Timeline,
  after: number,
  direction: "forwards" | "backwards",
): number | undefined {
  const { entries } = timeline;
  const step = direction === "forwards" ? 1 : -1;
  for (let index = after + step; index >= 0 && index < entries.length; index += step) {
    if (entries[index]?.status !== "answered") return index;
  }
  return undefined;
}

/** A duration for a screen: `0.4 s`, `12.5 s`, `3 min 5 s`. */
export function formatOffset(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60))} min ${String(whole % 60)} s`;
}
