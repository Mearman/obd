import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { body, cell, head, headRow, headerCell, openable, row, table } from "./DataTable.css";

/** What inside a row handles its own click. */
const INTERACTIVE = "button, a, input, select, textarea, [role=button], [role=dialog]";

/** One column of a {@link DataTable}. */
export interface Column<Row> {
  /** Column heading; on narrow screens it labels each value inside its card. */
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
}

/** Props of {@link DataTable}. */
export interface DataTableProps<Row> {
  /** Accessible name for the table. */
  readonly label: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  /** A stable key for a row. */
  readonly rowKey: (row: Row) => string;
  /** Makes each row open something: the name the row is announced by, and what activating it does. A click on a button or link inside the row does not activate the row. */
  readonly onOpen?: { readonly label: (row: Row) => string; readonly open: (row: Row) => void };
}

/**
 * A table on tablet and desktop widths that reflows to one card per row on a phone, so it never
 * scrolls sideways. ARIA roles keep the table semantics when CSS changes the display type.
 */
export function DataTable<Row>({ label, columns, rows, rowKey, onOpen }: DataTableProps<Row>) {
  return (
    <div role="table" aria-label={label} className={table}>
      <div role="rowgroup" className={head}>
        <div role="row" className={headRow}>
          {columns.map((column) => (
            <div key={column.header} role="columnheader" className={headerCell}>
              {column.header}
            </div>
          ))}
        </div>
      </div>
      <div role="rowgroup" className={body}>
        {rows.map((item) => (
          <div
            key={rowKey(item)}
            role="row"
            className={onOpen === undefined ? row : `${row} ${openable}`}
            {...(onOpen === undefined
              ? {}
              : {
                  "aria-label": onOpen.label(item),
                  tabIndex: 0,
                  "data-openable": "",
                  onClick: (event: MouseEvent<HTMLDivElement>) => {
                    // A portalled dialog's clicks reach the row through React but are not inside it in the page.
                    if (
                      event.target instanceof Element &&
                      event.currentTarget.contains(event.target) &&
                      event.target.closest(INTERACTIVE) === null
                    ) {
                      onOpen.open(item);
                    }
                  },
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      onOpen.open(item);
                    }
                  },
                })}
          >
            {columns.map((column) => (
              <div key={column.header} role="cell" data-label={column.header} className={cell}>
                <span>{column.render(item)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
