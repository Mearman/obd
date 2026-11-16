import { ORIGINS, type Origin } from "obd-read";
import { ALL_ORIGINS, ORIGIN_LABELS } from "../origin/origins";
import { profileTitle } from "../profiles/generic";
import type { DataTableGroup, SelectOption, SortDirection } from "../ui";
import {
  ALL_KINDS,
  KIND_LABELS,
  KIND_PLURALS,
  LIBRARY_KINDS,
  type LibraryItem,
  type LibraryKind,
} from "./items";

/** The columns the Library can be sorted by. */
export const SORT_COLUMNS = ["kind", "date", "profile", "origin"] as const;

/** One column the Library can be sorted by. */
export type SortColumn = (typeof SORT_COLUMNS)[number];

/** The column the Library is sorted by, and which way. */
export interface LibrarySort {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

/** How the address writes a sort: the column for ascending, the column after `-` for descending. */
export type SortValue = SortColumn | `-${SortColumn}`;

/** The sort each address value names. */
const SORTS: Readonly<Record<SortValue, LibrarySort>> = {
  kind: { column: "kind", direction: "ascending" },
  "-kind": { column: "kind", direction: "descending" },
  date: { column: "date", direction: "ascending" },
  "-date": { column: "date", direction: "descending" },
  profile: { column: "profile", direction: "ascending" },
  "-profile": { column: "profile", direction: "descending" },
  origin: { column: "origin", direction: "ascending" },
  "-origin": { column: "origin", direction: "descending" },
};

/** Every value the address's `sort` parameter may hold. */
export const SORT_VALUES = SORT_COLUMNS.flatMap((column) => [column, `-${column}` as const]);

/** The groupings the address names; not grouping at all is left out of it. */
export const GROUPINGS = ["kind", "origin", "day"] as const;

/** One way of grouping the Library's list. */
export type Grouping = (typeof GROUPINGS)[number];

/**
 * How the Library's list is filtered, sorted and grouped, as the address holds it.
 *
 * Dates are UTC days as `YYYY-MM-DD`, the way the list shows its times.
 */
export interface LibraryView {
  readonly kind: LibraryKind | typeof ALL_KINDS;
  readonly origin: Origin | typeof ALL_ORIGINS;
  /** Words every shown row must contain, in any case; blank shows every row. */
  readonly search: string;
  /** The first day shown, included; undefined for no first day. */
  readonly from: string | undefined;
  /** The last day shown, included; undefined for no last day. */
  readonly to: string | undefined;
  readonly sort: LibrarySort;
  /** What the list is grouped by, or undefined for one ungrouped list. */
  readonly group: Grouping | undefined;
}

/** The view an address with none of the Library's parameters shows: everything, newest first, not grouped. */
export const DEFAULT_VIEW: LibraryView = {
  kind: ALL_KINDS,
  origin: ALL_ORIGINS,
  search: "",
  from: undefined,
  to: undefined,
  sort: SORTS["-date"],
  group: undefined,
};

/** The address parameters a {@link LibraryView} is written to, each absent when at its default. */
export interface LibrarySearch {
  readonly kind: LibraryKind | undefined;
  readonly origin: Origin | undefined;
  readonly q: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly sort: SortValue | undefined;
  readonly group: Grouping | undefined;
}

/** The view the validated address describes, each part it leaves out at its default. */
export function viewFromSearch(search: Partial<LibrarySearch>): LibraryView {
  return {
    kind: search.kind ?? DEFAULT_VIEW.kind,
    origin: search.origin ?? DEFAULT_VIEW.origin,
    search: search.q ?? DEFAULT_VIEW.search,
    from: search.from,
    to: search.to,
    sort: search.sort === undefined ? DEFAULT_VIEW.sort : SORTS[search.sort],
    group: search.group,
  };
}

/** The address parameters for `view`, each one at its default undefined so the address leaves it out. */
export function viewToSearch(view: LibraryView): LibrarySearch {
  const { column, direction } = view.sort;
  const sorted = column === DEFAULT_VIEW.sort.column && direction === DEFAULT_VIEW.sort.direction;
  return {
    kind: view.kind === ALL_KINDS ? undefined : view.kind,
    origin: view.origin === ALL_ORIGINS ? undefined : view.origin,
    q: view.search === "" ? undefined : view.search,
    from: view.from,
    to: view.to,
    sort: sorted ? undefined : direction === "ascending" ? column : `-${column}`,
    group: view.group,
  };
}

/** The kind filter's choice for a value of its select, which offers every kind and {@link ALL_KINDS}. */
export function kindChoice(value: string): LibraryView["kind"] {
  return LIBRARY_KINDS.find((kind) => kind === value) ?? ALL_KINDS;
}

/** The origin filter's choice for a value of its select, which offers every origin and {@link ALL_ORIGINS}. */
export function originChoice(value: string): LibraryView["origin"] {
  return ORIGINS.find((origin) => origin === value) ?? ALL_ORIGINS;
}

/** The value of the group-by select that groups nothing. */
export const NO_GROUPING = "none";

/** The choices of the group-by select. */
export const GROUPING_OPTIONS: readonly SelectOption[] = [
  { value: NO_GROUPING, label: "None" },
  { value: "kind", label: "Kind" },
  { value: "origin", label: "Origin" },
  { value: "day", label: "Day" },
];

/** The grouping for a value of the group-by select, which offers every grouping and {@link NO_GROUPING}. */
export function groupingChoice(value: string): Grouping | undefined {
  return GROUPINGS.find((grouping) => grouping === value);
}

/** The sort after the person picks `column`: the same column turned around, or another one ascending. */
export function toggleSort(sort: LibrarySort, column: SortColumn): LibrarySort {
  if (sort.column !== column) return { column, direction: "ascending" };
  return { column, direction: sort.direction === "ascending" ? "descending" : "ascending" };
}

/** The UTC day of a moment as `YYYY-MM-DD`. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The profile as a row shows it. */
export function profileText(item: LibraryItem): string {
  return item.kind === "capture" && item.profile === null
    ? "no profile"
    : profileTitle(item.profile);
}

/** The text a search looks in: what the row shows of the item, and its id. */
function searchable(item: LibraryItem): string {
  const details =
    item.kind === "report"
      ? item.report.label
      : item.kind === "capture"
        ? item.capture.description
        : item.run.adapter;
  return [KIND_LABELS[item.kind], item.id, profileText(item), ORIGIN_LABELS[item.origin], details]
    .join(" ")
    .toLowerCase();
}

/** The items `view`'s search and date range let through, in their order; the kind and origin filters are applied when the items are read. */
export function shownItems(items: readonly LibraryItem[], view: LibraryView): LibraryItem[] {
  const words = view.search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return items.filter((item) => {
    const day = dayOf(item.at);
    if (view.from !== undefined && day < view.from) return false;
    if (view.to !== undefined && day > view.to) return false;
    const text = searchable(item);
    return words.every((word) => text.includes(word));
  });
}

/** Newest first, then in the order of {@link LIBRARY_KINDS}, then by id: the order among items a sort finds equal. */
function newestFirst(a: LibraryItem, b: LibraryItem): number {
  return (
    b.at - a.at ||
    LIBRARY_KINDS.indexOf(a.kind) - LIBRARY_KINDS.indexOf(b.kind) ||
    a.id.localeCompare(b.id)
  );
}

/** Compares two items by one column ascending, as the column reads. */
function byColumn(column: SortColumn, a: LibraryItem, b: LibraryItem): number {
  switch (column) {
    case "kind":
      return KIND_LABELS[a.kind].localeCompare(KIND_LABELS[b.kind]);
    case "date":
      return a.at - b.at;
    case "profile":
      return profileText(a).localeCompare(profileText(b));
    case "origin":
      return ORIGIN_LABELS[a.origin].localeCompare(ORIGIN_LABELS[b.origin]);
  }
}

/** The items in `sort`'s order; items it finds equal are newest first. */
export function sortItems(items: readonly LibraryItem[], sort: LibrarySort): LibraryItem[] {
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...items].sort((a, b) => sign * byColumn(sort.column, a, b) || newestFirst(a, b));
}

/** An item's group under `group`: its key, its heading, and where the group goes when the sort is by another column. */
function groupOf(
  item: LibraryItem,
  group: Grouping,
): { readonly key: string; readonly label: string; readonly rank: number } {
  switch (group) {
    case "kind":
      return {
        key: item.kind,
        label: KIND_PLURALS[item.kind],
        rank: LIBRARY_KINDS.indexOf(item.kind),
      };
    case "origin":
      return {
        key: item.origin,
        label: ORIGIN_LABELS[item.origin],
        rank: ORIGINS.indexOf(item.origin),
      };
    case "day": {
      const key = dayOf(item.at);
      const label = new Date(item.at).toLocaleDateString("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      // Newest day first.
      return { key, label, rank: -Date.parse(key) };
    }
  }
}

/** The column whose sort orders each grouping's groups. */
const GROUP_COLUMNS: Readonly<Record<Grouping, SortColumn>> = {
  kind: "kind",
  origin: "origin",
  day: "date",
};

/**
 * The sorted `items` in groups by `group`, each group keeping their order. When `sort` is by the column the grouping follows (the kind, the origin or the date), the groups come in that order; otherwise they come in the kinds' or the origins' own order, or newest day first.
 */
export function groupItems(
  items: readonly LibraryItem[],
  group: Grouping,
  sort: LibrarySort,
): DataTableGroup<LibraryItem>[] {
  const groups = new Map<string, { label: string; rank: number; rows: LibraryItem[] }>();
  for (const item of items) {
    const { key, label, rank } = groupOf(item, group);
    const found = groups.get(key);
    if (found === undefined) groups.set(key, { label, rank, rows: [item] });
    else found.rows.push(item);
  }
  const ordered = [...groups].map(([key, { label, rank, rows }]) => ({ key, label, rank, rows }));
  if (sort.column !== GROUP_COLUMNS[group]) ordered.sort((a, b) => a.rank - b.rank);
  return ordered.map(({ key, label, rows }) => ({ key, label, rows }));
}
