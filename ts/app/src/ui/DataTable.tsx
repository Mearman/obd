import type { ReactNode } from "react";
import { body, cell, head, headRow, headerCell, row, table } from "./DataTable.css";

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
}

/**
 * A table on tablet and desktop widths that reflows to one card per row on a phone, so it never
 * scrolls sideways. ARIA roles keep the table semantics when CSS changes the display type.
 */
export function DataTable<Row>({ label, columns, rows, rowKey }: DataTableProps<Row>) {
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
          <div key={rowKey(item)} role="row" className={row}>
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
