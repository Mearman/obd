import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { tableStyles } from "./DataTable.css";
const { group, groupHeading, groupToggle } = tableStyles.standard;

/** What inside a row handles its own click. */
const INTERACTIVE = "button, a, input, select, textarea, [role=button], [role=dialog]";

/** Which way a sorted column runs, in the words `aria-sort` takes. */
export type SortDirection = "ascending" | "descending";

/** One column of a {@link DataTable}. */
export interface Column<Row, Key extends string = string> {
  /** Column heading; on narrow screens it labels each value inside its card. */
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
  /** What the table's {@link DataTableProps.sorting} calls this column; a column without one cannot be sorted by. */
  readonly sortKey?: Key;
  /** For a column that shows several values, a sort button for each in its header, named by its `label`, in place of {@link sortKey}. */
  readonly sortKeys?: readonly { readonly label: string; readonly key: Key }[];
  /** Keeps the value on one line when the table is wide; leave it off for text that may be long. */
  readonly nowrap?: boolean;
  /** Shows the value on a phone's card with no heading beside it, for a control that needs none. */
  readonly bare?: boolean;
}

/** The sorted column of a {@link DataTable}, and what picking a column's header does. */
export interface DataTableSorting<Key extends string> {
  readonly key: Key;
  readonly direction: SortDirection;
  /** Called with the column's key when the person picks its header; the owner decides the new order and sorts the rows. */
  readonly onSort: (key: Key) => void;
}

/** Props of {@link DataTable}. */
export interface DataTableProps<Row, Key extends string = string> {
  /** Accessible name for the table. */
  readonly label: string;
  readonly columns: readonly Column<Row, Key>[];
  readonly rows: readonly Row[];
  /** A stable key for a row. */
  readonly rowKey: (row: Row) => string;
  /** Makes each row open something: the name the row is announced by, and what activating it does. A click on a button or link inside the row does not activate the row. */
  readonly onOpen?: { readonly label: (row: Row) => string; readonly open: (row: Row) => void };
  /** Makes each column with a {@link Column.sortKey} or {@link Column.sortKeys} sortable by a button in its header for each, the sorted one marked with `aria-sort`; on a phone those headers stay on screen above the cards. The rows are shown in the order given. */
  readonly sorting?: DataTableSorting<Key>;
  /** The width from which the table is a table rather than a card per row: `standard` (a tablet) or `roomy` (a laptop), for a table whose columns need the room. */
  readonly layout?: "standard" | "roomy";
}

type Styles = (typeof tableStyles)[keyof typeof tableStyles];

/** What a column's header holds: its heading, or a button that sorts by it with an arrow for the sorted direction. */
function Header<Row, Key extends string>({
  column,
  sorting,
  styles,
}: {
  readonly styles: Styles;
  readonly column: Column<Row, Key>;
  readonly sorting: DataTableSorting<Key> | undefined;
}) {
  const { headerCell, sortableHeaderCell, sortButton } = styles;
  const keys =
    column.sortKeys ??
    (column.sortKey === undefined ? [] : [{ label: column.header, key: column.sortKey }]);
  if (sorting === undefined || keys.length === 0) {
    return (
      <div role="columnheader" className={headerCell}>
        {column.header}
      </div>
    );
  }
  const direction = keys.some(({ key }) => key === sorting.key) ? sorting.direction : undefined;
  return (
    <div
      role="columnheader"
      className={`${headerCell} ${sortableHeaderCell}`}
      {...(direction === undefined ? {} : { "aria-sort": direction })}
    >
      {keys.map(({ label, key }) => {
        const sorted = key === sorting.key ? sorting.direction : undefined;
        return (
          <button
            key={key}
            type="button"
            className={sortButton}
            onClick={() => {
              sorting.onSort(key);
            }}
          >
            {label}
            <span aria-hidden>
              {sorted === "ascending" ? "▲" : sorted === "descending" ? "▼" : "↕"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A table on tablet and desktop widths that reflows to one card per row on a phone, so it never
 * scrolls sideways. ARIA roles keep the table semantics when CSS changes the display type.
 */
export function DataTable<Row, Key extends string = string>({
  label,
  columns,
  rows,
  rowKey,
  onOpen,
  sorting,
  layout = "standard",
}: DataTableProps<Row, Key>) {
  const styles = tableStyles[layout];
  const { bareCell, body, cell, nowrapCell, head, headRow, openable, row, sortableHead, table } =
    styles;
  return (
    <div role="table" aria-label={label} className={table}>
      <div role="rowgroup" className={sorting === undefined ? head : sortableHead}>
        <div role="row" className={headRow}>
          {columns.map((column) => (
            <Header key={column.header} column={column} sorting={sorting} styles={styles} />
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
              <div
                key={column.header}
                role="cell"
                data-label={column.header}
                className={[
                  cell,
                  column.nowrap === true ? nowrapCell : "",
                  column.bare === true ? bareCell : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span>{column.render(item)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One group of rows of a {@link GroupedDataTable}. */
export interface DataTableGroup<Row> {
  /** A key unique among the groups, which also keeps a group collapsed while its rows change. */
  readonly key: string;
  readonly label: string;
  readonly rows: readonly Row[];
}

/** Props of {@link GroupedDataTable}: a {@link DataTable}'s, with the rows in groups. */
export type GroupedDataTableProps<Row, Key extends string = string> = Omit<
  DataTableProps<Row, Key>,
  "rows"
> & {
  readonly groups: readonly DataTableGroup<Row>[];
};

/**
 * Rows in groups, each under a heading whose button collapses and expands it, and each group its own {@link DataTable} named `<label>, <group>`. Every group starts expanded.
 */
export function GroupedDataTable<Row, Key extends string = string>({
  groups,
  label,
  ...table
}: GroupedDataTableProps<Row, Key>) {
  const id = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  return groups.map((each, index) => {
    const expanded = !collapsed.has(each.key);
    const panel = `${id}-${String(index)}`;
    return (
      <section key={each.key} className={group}>
        <h2 className={groupHeading}>
          <button
            type="button"
            className={groupToggle}
            aria-expanded={expanded}
            aria-controls={panel}
            onClick={() => {
              toggle(each.key);
            }}
          >
            <span aria-hidden>{expanded ? "▾" : "▸"}</span>
            {`${each.label} (${String(each.rows.length)})`}
          </button>
        </h2>
        <div id={panel} hidden={!expanded}>
          {expanded && <DataTable {...table} label={`${label}, ${each.label}`} rows={each.rows} />}
        </div>
      </section>
    );
  });
}
