import type { Run } from "obd-read";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LineChart, formatElapsed, valueAt, type ChartMarker, type Series } from "../charts";
import { formatReadingWithUnit } from "../format/reading";
import { failureMessage, type DiagnosticsClient } from "../diagnostics/client";
import { Button, Card, DataTable } from "../ui";
import { charts, clock, controls, scrubber, speeds, transport } from "./RunGraphs.css";
import { loadRunSeries, type RunSeries } from "./run-series";
import { error, muted } from "./screen.css";

/** The playback speeds on offer, as multiples of real time. */
export const SPEEDS = [1, 2, 4] as const;

type Speed = (typeof SPEEDS)[number];

type Loaded =
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly data: RunSeries };

/** Props of {@link RunGraphs}. */
export interface RunGraphsProps {
  readonly client: DiagnosticsClient;
  readonly run: Run;
  readonly onClose: () => void;
}

function withUnit(value: number | undefined, unit: string): string {
  if (value === undefined) return "-";
  return formatReadingWithUnit(value, unit);
}

/** Moves a cursor across `[0, end]` at `speed` times real time while `playing`, and stops at the end. */
function usePlayback(end: number) {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const at = useRef(0);

  const move = useCallback((time: number) => {
    at.current = time;
    setCursor(time);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const next = at.current + (now - previous) * speed;
      previous = now;
      if (next >= end) {
        move(end);
        setPlaying(false);
        return;
      }
      move(next);
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, speed, end, move]);

  const toggle = useCallback(() => {
    if (!playing && at.current >= end) move(0);
    setPlaying((value) => !value);
  }, [playing, end, move]);

  return { cursor, move, playing, toggle, speed, setSpeed };
}

/**
 * Playback of a run's series: a chart per signal on the shared time axis with one cursor across them, play and pause, 1x, 2x and 4x speed, a scrubber and the values at the cursor as a table. `markers` are drawn on every chart, such as where each phase of a plan began.
 */
export function RunPlayer({
  data,
  markers,
}: {
  readonly data: RunSeries;
  readonly markers?: readonly ChartMarker[];
}) {
  const end = data.domain[1];
  const { cursor, move, playing, toggle, speed, setSpeed } = usePlayback(end);

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;
    const handlesSpace =
      target instanceof HTMLButtonElement ||
      (target instanceof HTMLInputElement && target.type !== "range");
    if (event.key === " " && !handlesSpace) {
      event.preventDefault();
      toggle();
    }
  }

  const rows = data.series.map((series) => ({ series, summary: data.summaries.get(series.key) }));
  const reading = (series: Series): string =>
    withUnit(valueAt(series.points, cursor)?.v, series.unit);

  return (
    // The region takes Space to play and pause from any chart or the scrubber; buttons keep their own.
    <div className={controls} role="group" aria-label="Run playback" onKeyDown={onKeyDown}>
      <div className={transport}>
        <Button variant="primary" aria-pressed={playing} onClick={toggle}>
          {playing ? "Pause" : "Play"}
        </Button>
        <div className={speeds} role="group" aria-label="Playback speed">
          {SPEEDS.map((choice) => (
            <Button
              key={choice}
              variant={choice === speed ? "primary" : "secondary"}
              aria-pressed={choice === speed}
              onClick={() => {
                setSpeed(choice);
              }}
            >
              {`${String(choice)}x`}
            </Button>
          ))}
        </div>
        <span className={clock} aria-live="off">
          {formatElapsed(cursor)} / {formatElapsed(end)}
        </span>
      </div>
      <input
        className={scrubber}
        type="range"
        min={0}
        max={end}
        step={1}
        value={Math.round(cursor)}
        aria-label="Position in the run"
        aria-valuetext={`${formatElapsed(cursor)} of ${formatElapsed(end)}`}
        onChange={(event) => {
          move(Number(event.currentTarget.value));
        }}
      />
      <div className={charts}>
        {data.series.map((series) => (
          <LineChart
            key={series.key}
            name={series.signal}
            unit={series.unit}
            points={series.points}
            domain={data.domain}
            cursor={cursor}
            onCursorChange={move}
            {...(markers === undefined ? {} : { markers })}
          />
        ))}
      </div>
      <DataTable
        label="Values at the cursor"
        columns={[
          {
            header: "Signal",
            render: ({ series }) =>
              series.unit === "" ? series.signal : `${series.signal} (${series.unit})`,
          },
          { header: "At cursor", render: ({ series }) => reading(series) },
          { header: "Readings", render: ({ summary }) => String(summary?.readings ?? "-") },
          { header: "Min", render: ({ summary }) => String(summary?.min ?? "-") },
          { header: "Max", render: ({ summary }) => String(summary?.max ?? "-") },
        ]}
        rows={rows}
        rowKey={({ series }) => series.key}
      />
    </div>
  );
}

/**
 * The graphs of one stored run: a chart per signal on a shared time axis, a cursor that moves across all of them with its value written beside each, playback with a scrubber and 1x, 2x and 4x speed, and the values at the cursor as a table, which is also the text alternative to the drawings.
 *
 * Samples are read a page at a time and thinned as they arrive, so a long run never puts more than a bounded number of points in memory or in the document.
 */
export function RunGraphs({ client, run, onClose }: RunGraphsProps) {
  // The result belongs to the run it was read for, so a different run reads as loading at once.
  const [result, setResult] = useState<{ readonly run: Run; readonly loaded: Loaded } | undefined>(
    undefined,
  );
  const loaded = result?.run === run ? result.loaded : undefined;

  useEffect(() => {
    const live = { active: true };
    loadRunSeries(client, run).then(
      (data) => {
        if (live.active) setResult({ run, loaded: { status: "ready", data } });
      },
      (caught: unknown) => {
        if (live.active) {
          setResult({
            run,
            loaded: {
              status: "failed",
              message: failureMessage(caught, "Could not read the run."),
            },
          });
        }
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, run]);

  const data = loaded?.status === "ready" ? loaded.data : undefined;
  const description = useMemo(
    () =>
      `Run started ${new Date(run.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.`,
    [run.startedAt],
  );

  return (
    <Card title="Graphs" description={description}>
      {loaded === undefined && <p className={muted}>Loading graphs…</p>}
      {loaded?.status === "failed" && (
        <p role="alert" className={error}>
          {loaded.message}
        </p>
      )}
      {data?.series.length === 0 && (
        <p className={muted}>This run has no numeric readings to chart.</p>
      )}
      {data !== undefined && data.series.length > 0 && <RunPlayer data={data} />}
      {data !== undefined && data.textReadings > 0 && (
        <p className={muted}>Text readings are not charted; they are in the exports.</p>
      )}
      <div>
        <Button onClick={onClose}>Close graphs</Button>
      </div>
    </Card>
  );
}
