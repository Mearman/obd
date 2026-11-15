import type { Capture, DecodedCaptureData } from "obd-read";
import { buildTimeline } from "obd-read";
import { useEffect, useMemo, useRef, useState } from "react";
import { error, muted, stack } from "../../screens/screen.css";
import { Switch } from "../../ui";
import { DecodedView } from "../DecodedView";
import { ExchangeWindow } from "./ExchangeWindow";
import { describeCursor, PlaybackPanel } from "./PlaybackPanel";
import { busy } from "./playback.css";
import { usePlayback } from "./use-playback";

/** How long fast playback waits for the cursor to settle before decoding it, in milliseconds, so a burst of ticks costs one decoding. */
const SETTLE_MS = 150;

/** Decodes a capture as it stood after its first `count` exchanges, under the profile chosen where the view is used. Never sends anything anywhere. */
export type DecodeAt = (count: number) => Promise<DecodedCaptureData>;

/** What the partial decoding is for: the cursor it was made at. */
interface Partial {
  readonly count: number;
  readonly decoded: DecodedCaptureData;
}

/**
 * A decoded capture with playback: the controls above, the exchanges so far in a windowed list, and the decoded tables as of the cursor. At the end of the capture, or with "Show everything" on, it is the decoded view exactly as it was before playback existed. Moving the cursor back turns "Show everything" off.
 *
 * `decodeAt` must change identity whenever the decoding choice does, so the view decodes again.
 */
export function PlaybackView({
  capture,
  decoded,
  decodeAt,
}: {
  readonly capture: Capture;
  /** The whole capture's decoding, shown while everything is shown. */
  readonly decoded: DecodedCaptureData;
  readonly decodeAt: DecodeAt;
}) {
  const timeline = useMemo(() => buildTimeline(capture), [capture]);
  const playback = usePlayback(timeline);
  const { count, total, playing } = playback;
  const [showEverything, setShowEverything] = useState(true);
  const [partial, setPartial] = useState<Partial | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const everything = showEverything || count >= total;
  const exchanges = useMemo(
    () => (everything ? capture.exchanges : capture.exchanges.slice(0, count)),
    [everything, capture, count],
  );
  // The cursor's exchanges when the view is not showing everything.
  const sofar = useMemo(() => capture.exchanges.slice(0, count), [capture, count]);

  // Moving the cursor off the end leaves "Show everything"; the switch puts it back.
  const previous = useRef(count);
  useEffect(() => {
    if (count < total && previous.current >= total) setShowEverything(false);
    previous.current = count;
  }, [count, total]);

  useEffect(() => {
    if (everything) return;
    const live = { active: true };
    const timer = setTimeout(
      () => {
        decodeAt(count).then(
          (result) => {
            if (!live.active) return;
            setPartial({ count, decoded: result });
            setProblem(undefined);
          },
          (caught: unknown) => {
            if (live.active) {
              setProblem(
                caught instanceof Error ? caught.message : "The capture could not be decoded.",
              );
            }
          },
        );
      },
      playing ? SETTLE_MS : 0,
    );
    return () => {
      live.active = false;
      clearTimeout(timer);
    };
  }, [everything, count, playing, decodeAt]);

  // The live region: every move while paused, and while playing only what went wrong, so fast playback stays quiet. The text is set while rendering, from the cursor, rather than in an effect.
  const status = timeline.entries[count - 1]?.status;
  const speaks = !playing || status === "negative" || status === "unanswered";
  const spoken = `${String(count)}|${String(speaks)}`;
  const [announced, setAnnounced] = useState({ key: spoken, text: "" });
  if (announced.key !== spoken) {
    setAnnounced({
      key: spoken,
      text: speaks ? describeCursor(timeline, capture.exchanges, count) : announced.text,
    });
  }

  const stale = !everything && partial?.count !== count;
  const shown =
    everything || partial === undefined
      ? { capture, decoded: everything ? decoded : undefined }
      : {
          capture: { ...capture, exchanges: capture.exchanges.slice(0, partial.count) },
          decoded: partial.decoded,
        };

  return (
    <div className={stack}>
      <PlaybackPanel
        timeline={timeline}
        exchanges={capture.exchanges}
        playback={playback}
        announcement={announced.text}
      />
      <Switch
        label="Show everything"
        checked={showEverything}
        onCheckedChange={setShowEverything}
      />
      <p className={muted}>
        {everything
          ? `All ${String(total)} exchanges are shown.`
          : `Showing the ${String(count)} of ${String(total)} exchanges up to the cursor, with each value as last read.`}
      </p>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      <ExchangeWindow
        exchanges={everything ? exchanges : sofar}
        label={everything ? "Every exchange" : "Exchanges up to the cursor"}
      />
      <div className={stale ? busy : undefined} aria-busy={stale}>
        {shown.decoded !== undefined && (
          <DecodedView capture={shown.capture} decoded={shown.decoded} />
        )}
      </div>
    </div>
  );
}
