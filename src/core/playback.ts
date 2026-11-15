/**
 * Replaying a capture over time: an ordered timeline of its exchanges, and the state of the capture "as of" any point on it.
 *
 * Playback is a reading of stored data only. Nothing here sends anything: {@link decodeAsOf} runs {@link decodeCapture} over the exchanges recorded up to the cursor, so a value shown at the cursor is what the same readers make of those exchanges. A capture is recorded as fast as the adapter answers, so its own times can be too close together to watch: the timeline keeps each exchange's recorded time and also a playback time whose gaps are clamped to {@link MIN_GAP_MS} and {@link MAX_GAP_MS}. This module is platform-free.
 */

import type { Capture } from "./capture.js";
import { decodeCapture, type DecodeTarget, type DecodedCapture } from "./decode.js";
import { addressKey, type Exchange } from "./exchange.js";

/** The shortest playback gap between two exchanges, in milliseconds, so a burst recorded in one instant is still watchable. */
export const MIN_GAP_MS = 100;

/** The longest playback gap between two exchanges, in milliseconds, so a long pause in the recording does not stall playback. */
export const MAX_GAP_MS = 2000;

/** How an exchange ended, for marking it on a timeline. */
export type ExchangeStatus = "answered" | "negative" | "unanswered";

/** One exchange placed on the timeline. */
export interface TimelineEntry {
  /** Its position in the capture's exchange list. */
  readonly index: number;
  readonly seq: number;
  /** The recorded time of the request, in milliseconds since the Unix epoch. */
  readonly at: number;
  /** Milliseconds from the first exchange's recorded time to this one's. */
  readonly offsetMs: number;
  /** The playback time: milliseconds from the first exchange, with every gap clamped. The first entry is at 0 and the times never decrease. */
  readonly t: number;
  readonly status: ExchangeStatus;
}

/** A capture's exchanges in order, with their times. */
export interface Timeline {
  readonly entries: readonly TimelineEntry[];
  /** The playback time of the last exchange; 0 for none or one. */
  readonly duration: number;
}

/** Whether a message is a negative response (`7F`, the refused service, the code). */
function isNegative(message: string): boolean {
  return message.startsWith("7F") && message.length >= 6;
}

/**
 * How an exchange ended: `negative` when a sender's final message refuses the request (an earlier "response pending" refusal followed by a real answer is not one), `unanswered` when nobody answered or the adapter or link failed, otherwise `answered`.
 */
export function exchangeStatus(exchange: Exchange): ExchangeStatus {
  const { outcome } = exchange;
  if (outcome.kind !== "replies") return "unanswered";
  return outcome.replies.some(({ messages }) => {
    const last = messages.at(-1);
    return last !== undefined && isNegative(last);
  })
    ? "negative"
    : "answered";
}

/** The timeline of a capture's exchanges, in capture order. */
export function buildTimeline(capture: Capture): Timeline {
  const [first] = capture.exchanges;
  if (first === undefined) return { entries: [], duration: 0 };
  let t = 0;
  let previous = first.at;
  const entries = capture.exchanges.map((exchange, index): TimelineEntry => {
    if (index > 0) t += Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, exchange.at - previous));
    previous = exchange.at;
    return {
      index,
      seq: exchange.seq,
      at: exchange.at,
      offsetMs: Math.max(0, exchange.at - first.at),
      t,
      status: exchangeStatus(exchange),
    };
  });
  return { entries, duration: t };
}

/** How many exchanges have happened by playback time `t`: those at or before it. */
export function countAt(timeline: Timeline, t: number): number {
  const { entries } = timeline;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const entry = entries[middle];
    if (entry !== undefined && entry.t <= t) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The playback time at which `count` exchanges have happened: that of the last of them, or 0 for none. */
export function timeOfCount(timeline: Timeline, count: number): number {
  return timeline.entries[Math.min(count, timeline.entries.length) - 1]?.t ?? 0;
}

/** The exchanges up to the cursor, and the capture the decoder reads them from. */
export interface CaptureAsOf {
  /** Every exchange so far, in capture order. */
  readonly exchanges: readonly Exchange[];
  /** The exchanges so far with a repeated request kept only at its latest read, so a decoder that takes the first read of a request decodes the last one seen. */
  readonly decodable: Capture;
}

/** The identity of a request for deciding which read of it is the latest: where it went, on which bus, and its bytes. */
function requestKey(exchange: Exchange): string {
  return `${addressKey(exchange.address)}|${JSON.stringify(exchange.bus)}|${exchange.request}`;
}

/** The first `count` exchanges of `capture`, as the cursor at `count` shows them. */
export function captureAsOf(capture: Capture, count: number): CaptureAsOf {
  const exchanges = capture.exchanges.slice(0, Math.max(0, count));
  const latest = new Map<string, number>();
  exchanges.forEach((exchange, index) => latest.set(requestKey(exchange), index));
  const kept = exchanges.filter((exchange, index) => latest.get(requestKey(exchange)) === index);
  return { exchanges, decodable: { ...capture, exchanges: kept } };
}

/**
 * Decodes the capture as of the first `count` exchanges: every value is the latest read of its request among them, and `exchanges` counts all of them. An exchange a later read of the same request replaced is not in `undecoded`, since the decoder read that request.
 */
export async function decodeAsOf(
  capture: Capture,
  target: DecodeTarget,
  count: number,
): Promise<DecodedCapture> {
  const { exchanges, decodable } = captureAsOf(capture, count);
  const decoded = await decodeCapture(decodable, target);
  return { ...decoded, exchanges: exchanges.length };
}

/** The state of a capture at one point of its playback. */
export interface PlaybackState {
  /** How many exchanges have happened. */
  readonly count: number;
  /** Every exchange so far, in capture order. */
  readonly exchanges: readonly Exchange[];
  readonly decoded: DecodedCapture;
}

/** The capture as of playback time `t`: the exchanges so far and what they decode to under `target`. */
export async function playbackStateAt(
  capture: Capture,
  timeline: Timeline,
  target: DecodeTarget,
  t: number,
): Promise<PlaybackState> {
  const count = countAt(timeline, t);
  return {
    count,
    exchanges: capture.exchanges.slice(0, count),
    decoded: await decodeAsOf(capture, target, count),
  };
}
