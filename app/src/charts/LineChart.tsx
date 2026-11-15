import { formatReading, formatReadingWithUnit } from "../format/reading";
import { useMemo, type KeyboardEvent, type PointerEvent } from "react";
import {
  VIEW_HEIGHT,
  VIEW_WIDTH,
  describeSeries,
  extentOf,
  formatElapsed,
  fraction,
  polyline,
  stepTime,
  valueAt,
  type Point,
} from "./series";
import {
  body,
  caption,
  captionName,
  chart,
  compact,
  compactSvg,
  cursorDot,
  cursorLine,
  grid,
  line,
  plot,
  plotWrap,
  reading,
  slider,
  markerLabel,
  markerLayer,
  markerLine,
  svg,
  xAxis,
  yAxis,
} from "./LineChart.css";

/** Props of {@link LineChart}. */
export interface LineChartProps {
  /** What the chart shows; names it for assistive technology. */
  readonly name: string;
  /** The unit of the values; empty for none. */
  readonly unit: string;
  /** The readings in time order, with times on the same axis as `domain`. */
  readonly points: readonly Point[];
  /** The time axis, shared between charts so they line up. Defaults to the span of `points`. */
  readonly domain?: readonly [number, number];
  /** `full` has labelled axes and a cursor readout; `compact` is a bare trend line for a table cell. */
  readonly variant?: "full" | "compact";
  /** Where the cursor is on the time axis; none is drawn when undefined. Full variant only. */
  readonly cursor?: number | undefined;
  /** Called with a new cursor time when the user points at the chart or uses its arrow keys. Without it the chart is not interactive. */
  readonly onCursorChange?: (time: number) => void;
  /** Times on the axis to mark with a labelled vertical line, such as where each phase of a plan began. Full variant only. */
  readonly markers?: readonly ChartMarker[];
}

/** A labelled time on a chart's axis. */
export interface ChartMarker {
  readonly at: number;
  readonly label: string;
}

/**
 * A line chart drawn as plain SVG that scales with its container.
 *
 * Only the line is SVG: axis labels, the cursor and its readout are HTML, so text keeps its size from a 320 px phone to a desktop. The drawing is exposed as one image with a text summary; the cursor is a separate slider (arrow keys step between readings, Home and End jump to the ends, a pointer sets it) that reads out the value at its time. The value at the cursor is also written as text, so the chart never relies on colour alone.
 */
export function LineChart({
  name,
  unit,
  points,
  domain,
  variant = "full",
  cursor,
  onCursorChange,
  markers = [],
}: LineChartProps) {
  const first = points[0];
  const last = points[points.length - 1];
  const span: readonly [number, number] = domain ?? [first?.t ?? 0, last?.t ?? 1];
  const extent = useMemo(() => extentOf(points), [points]);
  const path = useMemo(
    () => (extent === undefined ? "" : polyline(points, span, extent)),
    // The domain's two ends are the dependencies; the tuple's identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, extent, span[0], span[1]],
  );
  const summary = useMemo(() => describeSeries(name, unit, points), [name, unit, points]);

  if (variant === "compact") {
    return (
      <span
        className={compact}
        role="img"
        aria-label={`Trend of ${name}`}
        aria-description={summary}
      >
        <svg
          className={compactSvg}
          viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline className={line} points={path} vectorEffect="non-scaling-stroke" />
        </svg>
      </span>
    );
  }

  const label = unit === "" ? name : `${name} (${unit})`;
  const at = cursor === undefined ? undefined : valueAt(points, cursor);
  const readout =
    cursor === undefined
      ? "-"
      : at === undefined
        ? "no reading yet"
        : formatReadingWithUnit(at.v, unit);
  const cursorLeft = cursor === undefined ? undefined : fraction(cursor, span[0], span[1]) * 100;
  const cursorTop =
    at === undefined || extent === undefined
      ? undefined
      : (1 - fraction(at.v, extent.min, extent.max)) * 100;

  function timeAt(event: PointerEvent<HTMLElement>): number {
    const box = event.currentTarget.getBoundingClientRect();
    const across = box.width <= 0 ? 0 : (event.clientX - box.left) / box.width;
    return span[0] + Math.min(1, Math.max(0, across)) * (span[1] - span[0]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (onCursorChange === undefined) return;
    const from = cursor ?? span[0];
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      next = event.shiftKey
        ? from + direction * (span[1] - span[0]) * 0.1
        : stepTime(points, from, direction);
    } else if (event.key === "Home") next = span[0];
    else if (event.key === "End") next = span[1];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onCursorChange(Math.min(span[1], Math.max(span[0], next)));
  }

  return (
    <figure className={chart}>
      <figcaption className={caption}>
        <span className={captionName}>{label}</span>
        <span className={reading}>{readout}</span>
      </figcaption>
      <div className={body}>
        <div className={yAxis} aria-hidden="true">
          <span>{extent === undefined ? "" : formatReading(extent.max, unit)}</span>
          <span>{extent === undefined ? "" : formatReading(extent.min, unit)}</span>
        </div>
        <div className={plotWrap}>
          <div className={plot} role="img" aria-label={summary}>
            <svg
              className={svg}
              viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <line
                className={grid}
                x1="0"
                x2={VIEW_WIDTH}
                y1="0"
                y2="0"
                vectorEffect="non-scaling-stroke"
              />
              <line
                className={grid}
                x1="0"
                x2={VIEW_WIDTH}
                y1={VIEW_HEIGHT / 2}
                y2={VIEW_HEIGHT / 2}
                vectorEffect="non-scaling-stroke"
              />
              <polyline className={line} points={path} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          {markers.length > 0 && (
            <div className={markerLayer} aria-hidden="true">
              {markers.map((marker) => (
                <div
                  key={`${String(marker.at)}-${marker.label}`}
                  className={markerLine}
                  style={{ left: `${(fraction(marker.at, span[0], span[1]) * 100).toFixed(2)}%` }}
                  title={marker.label}
                  aria-hidden="true"
                >
                  <span className={markerLabel}>{marker.label}</span>
                </div>
              ))}
            </div>
          )}
          {cursorLeft !== undefined && (
            <div
              className={cursorLine}
              style={{ left: `${cursorLeft.toFixed(2)}%` }}
              aria-hidden="true"
            />
          )}
          {cursorLeft !== undefined && cursorTop !== undefined && (
            <div
              className={cursorDot}
              style={{ left: `${cursorLeft.toFixed(2)}%`, top: `${cursorTop.toFixed(2)}%` }}
              aria-hidden="true"
            />
          )}
          {onCursorChange !== undefined && (
            <div
              className={slider}
              role="slider"
              tabIndex={0}
              aria-label={`Cursor on ${label}`}
              aria-valuemin={span[0]}
              aria-valuemax={span[1]}
              aria-valuenow={cursor ?? span[0]}
              aria-valuetext={
                cursor === undefined ? "not set" : `${formatElapsed(cursor - span[0])}, ${readout}`
              }
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                onCursorChange(timeAt(event));
              }}
              onPointerMove={(event) => {
                onCursorChange(timeAt(event));
              }}
              onKeyDown={onKeyDown}
            />
          )}
        </div>
        <div className={xAxis} aria-hidden="true">
          <span>{formatElapsed(0)}</span>
          <span>{formatElapsed(span[1] - span[0])}</span>
        </div>
      </div>
    </figure>
  );
}
