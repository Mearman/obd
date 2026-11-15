import { describeAddress, describeOutcome, exchangeStatus, type Exchange } from "obd-read";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../ui";
import { rowBody, rowHead, rowItem, rowText, windowInner, windowScroll } from "./playback.css";
import { STATUS_LABELS } from "./status";

/** The height of one row, in CSS pixels. Fixed, so the rows in view follow from the scroll position alone. */
export const ROW_HEIGHT = 64;

/** How many rows the window shows at once. */
export const WINDOW_ROWS = 6;

/** Rows drawn above and below the ones in view, so a fast scroll does not show blanks. */
const OVERSCAN = 3;

/**
 * The exchanges so far as a scrolling list that draws only the rows in view, however many there are. The latest exchange (`following`) is kept in view as the cursor moves; scrolling by hand moves away from it until the cursor next moves.
 */
export function ExchangeWindow({
  exchanges,
  label,
}: {
  readonly exchanges: readonly Exchange[];
  readonly label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const total = exchanges.length;

  // Follow the latest exchange whenever the list grows or shrinks to a new end.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const bottom = Math.max(0, total * ROW_HEIGHT - WINDOW_ROWS * ROW_HEIGHT);
    element.scrollTop = bottom;
    setTop(bottom);
  }, [total]);

  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, Math.ceil(top / ROW_HEIGHT) + WINDOW_ROWS + OVERSCAN);
  const rows = exchanges.slice(first, last);

  return (
    <div
      ref={scroller}
      className={windowScroll}
      style={{ height: WINDOW_ROWS * ROW_HEIGHT }}
      role="list"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        setTop(event.currentTarget.scrollTop);
      }}
    >
      <div className={windowInner} style={{ height: total * ROW_HEIGHT }}>
        {rows.map((exchange, offset) => {
          const index = first + offset;
          const status = exchangeStatus(exchange);
          return (
            <div
              key={exchange.seq}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={total}
              className={rowItem}
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <div className={rowHead}>
                <strong>#{exchange.seq}</strong>
                <span className={rowText}>{describeAddress(exchange.address)}</span>
                <Badge tone={status === "answered" ? "success" : "warning"}>
                  {STATUS_LABELS[status]}
                </Badge>
              </div>
              <div className={rowBody}>
                <code>{exchange.request}</code>
                {" → "}
                <code>{describeOutcome(exchange)}</code>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
