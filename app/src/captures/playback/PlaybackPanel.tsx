import type { Exchange, Timeline } from "obd-read";
import { describeAddress } from "obd-read";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { Button } from "../../ui";
import {
  cell,
  cellAnswered,
  cellFuture,
  cellNegative,
  cellUnanswered,
  controls,
  cursor,
  legend,
  mark,
  markNegative,
  markUnanswered,
  marks,
  now,
  panel,
  scrubber,
  speeds,
  strip,
  visuallyHidden,
} from "./playback.css";
import { STATUS_GLYPHS, STATUS_LABELS } from "./status";
import { formatOffset, nextIssue, stripCells } from "./strip";
import { SPEEDS, type Playback } from "./use-playback";

const CELL_CLASS = {
  answered: cellAnswered,
  negative: cellNegative,
  unanswered: cellUnanswered,
} as const;

/** The keys the scrubber moves the cursor with, as the change in exchanges, or `"start"` and `"end"`. */
function keyMove(key: string): number | "start" | "end" | undefined {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return -1;
    case "ArrowRight":
    case "ArrowUp":
      return 1;
    case "PageDown":
      return -10;
    case "PageUp":
      return 10;
    case "Home":
      return "start";
    case "End":
      return "end";
    default:
      return undefined;
  }
}

/** The words that say where the cursor is: which exchange of how many, when, and how it ended. */
export function describeCursor(
  timeline: Timeline,
  exchanges: readonly Exchange[],
  count: number,
): string {
  const entry = timeline.entries[count - 1];
  const exchange = exchanges[count - 1];
  if (entry === undefined || exchange === undefined) {
    return `Before the first of ${String(timeline.entries.length)} exchanges.`;
  }
  return `Exchange ${String(count)} of ${String(timeline.entries.length)}, ${formatOffset(entry.offsetMs)} in: ${exchange.request} to ${describeAddress(exchange.address)}, ${STATUS_LABELS[entry.status].toLowerCase()}.`;
}

/**
 * The playback controls: a strip marking every stretch of the capture (refused and unanswered exchanges by shape and word as well as colour), a scrubber, play and pause, step, speed, and a line saying where the cursor is. Keyboard: Space plays or pauses, the arrow keys move one exchange, Page Up and Page Down ten, Home and End the ends. Playback only moves a cursor over stored exchanges; it never sends anything to an adapter.
 */
export function PlaybackPanel({
  timeline,
  exchanges,
  playback,
  announcement,
}: {
  readonly timeline: Timeline;
  readonly exchanges: readonly Exchange[];
  readonly playback: Playback;
  /** What the live region says; the parent decides when it changes so fast playback stays quiet. */
  readonly announcement: string;
}) {
  const { count, total, playing } = playback;
  const cells = useMemo(() => stripCells(timeline), [timeline]);
  const counts = useMemo(() => {
    const tally = { answered: 0, negative: 0, unanswered: 0 };
    for (const entry of timeline.entries) tally[entry.status] += 1;
    return tally;
  }, [timeline]);
  const problems = useMemo(() => cells.filter((item) => item.status !== "answered"), [cells]);
  const current = timeline.entries[count - 1];

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === " ") {
      event.preventDefault();
      if (playing) playback.pause();
      else playback.play();
      return;
    }
    const move = keyMove(event.key);
    if (move === undefined) return;
    event.preventDefault();
    if (move === "start") playback.seek(0);
    else if (move === "end") playback.seek(total);
    else playback.step(move);
  }

  function onStripClick(event: MouseEvent<HTMLDivElement>): void {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    playback.seek(Math.ceil(fraction * total));
  }

  function jump(direction: "forwards" | "backwards"): void {
    const index = nextIssue(timeline, count - 1, direction);
    if (index !== undefined) playback.seek(index + 1);
  }

  return (
    <section className={panel} aria-label="Playback">
      <div className={strip} aria-hidden="true" onClick={onStripClick} data-testid="strip">
        {cells.map((item) => (
          <span
            key={item.from}
            className={`${cell} ${CELL_CLASS[item.status]} ${item.from >= count ? cellFuture : ""}`}
          />
        ))}
        <span
          className={cursor}
          style={{ left: `${String(total === 0 ? 0 : (count / total) * 100)}%` }}
        />
      </div>
      <div className={marks} aria-hidden="true">
        {problems.map((item) => (
          <span
            key={item.from}
            className={`${mark} ${item.status === "negative" ? markNegative : markUnanswered}`}
            style={{ left: `${String(((item.from + 0.5) / total) * 100)}%` }}
          >
            {STATUS_GLYPHS[item.status]}
          </span>
        ))}
      </div>
      <input
        type="range"
        className={scrubber}
        min={0}
        max={total}
        step={1}
        value={count}
        aria-label="Playback position"
        aria-valuetext={describeCursor(timeline, exchanges, count)}
        disabled={total === 0}
        onChange={(event) => {
          playback.seek(Number(event.currentTarget.value));
        }}
        onKeyDown={onKeyDown}
      />
      <div className={controls}>
        <Button
          variant="primary"
          disabled={total === 0}
          onClick={playing ? playback.pause : playback.play}
        >
          {playing ? "Pause" : playback.atEnd ? "Replay" : "Play"}
        </Button>
        <Button
          disabled={total === 0 || playback.atEnd}
          onClick={() => {
            playback.pause();
            playback.step(1);
          }}
        >
          Step to next exchange
        </Button>
        <Button
          disabled={total === 0 || count === 0}
          onClick={() => {
            playback.pause();
            playback.step(-1);
          }}
        >
          Step back
        </Button>
        <fieldset className={speeds}>
          <legend className={visuallyHidden}>Speed</legend>
          {SPEEDS.map((speed) => (
            <Button
              key={speed}
              variant={playback.speed === speed ? "primary" : "secondary"}
              aria-pressed={playback.speed === speed}
              aria-label={`${String(speed)} times speed`}
              onClick={() => {
                playback.setSpeed(speed);
              }}
            >
              {`${String(speed)}x`}
            </Button>
          ))}
        </fieldset>
        <Button
          variant="ghost"
          disabled={nextIssue(timeline, count - 1, "backwards") === undefined}
          onClick={() => {
            jump("backwards");
          }}
        >
          Previous problem
        </Button>
        <Button
          variant="ghost"
          disabled={nextIssue(timeline, count - 1, "forwards") === undefined}
          onClick={() => {
            jump("forwards");
          }}
        >
          Next problem
        </Button>
      </div>
      <p className={now}>
        {describeCursor(timeline, exchanges, count)}
        {current === undefined ? "" : ` ${STATUS_GLYPHS[current.status]}`}
      </p>
      <ul className={legend} aria-label="Key">
        <li>{`${STATUS_GLYPHS.answered} ${STATUS_LABELS.answered} ${String(counts.answered)}`}</li>
        <li>{`${STATUS_GLYPHS.negative} ${STATUS_LABELS.negative} ${String(counts.negative)}`}</li>
        <li>
          {`${STATUS_GLYPHS.unanswered} ${STATUS_LABELS.unanswered} ${String(counts.unanswered)}`}
        </li>
      </ul>
      <p role="status" className={visuallyHidden}>
        {announcement}
      </p>
    </section>
  );
}
