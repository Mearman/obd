import type { Timeline } from "obd-read";
import { useCallback, useEffect, useState } from "react";

/** The speeds playback offers, as multiples of the playback times. */
export const SPEEDS = [1, 2, 4] as const;

/** A speed playback offers. */
export type Speed = (typeof SPEEDS)[number];

/** The controls and state of one playback. */
export interface Playback {
  /** How many exchanges have happened at the cursor, from 0 to the capture's total. */
  readonly count: number;
  readonly playing: boolean;
  readonly speed: Speed;
  readonly total: number;
  readonly atEnd: boolean;
  /** Moves the cursor to `count` exchanges, clamped, and pauses nothing. */
  readonly seek: (count: number) => void;
  readonly step: (by: number) => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly setSpeed: (speed: Speed) => void;
}

/**
 * The cursor of a playback over a timeline, starting at the end so a capture opens showing everything; a different capture gets a new playback (give the component a `key`). Playing from the end starts again at the first exchange; each exchange appears after the playback gap before it divided by the speed. Nothing is sent anywhere: this only moves a number.
 */
export function usePlayback(timeline: Timeline): Playback {
  const total = timeline.entries.length;
  const [count, setCount] = useState(total);
  const [requested, setRequested] = useState(false);
  const playing = requested && count < total;
  const [speed, setSpeed] = useState<Speed>(1);

  useEffect(() => {
    if (!playing) return;
    const next = timeline.entries[count];
    if (next === undefined) return;
    const gap = next.t - (timeline.entries[count - 1]?.t ?? next.t);
    const timer = setTimeout(
      () => {
        setCount(count + 1);
        if (count + 1 >= total) setRequested(false);
      },
      count === 0 ? 0 : gap / speed,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [playing, count, speed, timeline, total]);

  const seek = useCallback(
    (to: number) => {
      setCount(Math.min(total, Math.max(0, Math.round(to))));
    },
    [total],
  );
  const step = useCallback(
    (by: number) => {
      setCount((current) => Math.min(total, Math.max(0, current + by)));
    },
    [total],
  );
  const play = useCallback(() => {
    if (total === 0) return;
    setCount((current) => (current >= total ? 0 : current));
    setRequested(true);
  }, [total]);
  const pause = useCallback(() => {
    setRequested(false);
  }, []);

  return { count, playing, speed, total, atEnd: count >= total, seek, step, play, pause, setSpeed };
}
