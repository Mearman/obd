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
export const GROUPINGS = ["kind", "vehicle", "origin", "day"] as const;

/** One way of grouping the Library's list. */
export type Grouping = (typeof GROUPINGS)[number];

/** The vehicle filter's value for every vehicle; the address leaves it out. */
export const ALL_VEHICLES = "all";

/** The vehicle filter's value, and the address's `vehicle`, for the items whose VIN is not known. A stored VIN is upper case, so it never reads as this. */
export const UNKNOWN_VEHICLE = "unknown";

/**
 * How the Library's list is filtered, sorted and grouped, as the address holds it.
 *
 * Dates are UTC days as `YYYY-MM-DD`, the way the list shows its times.
 */
export interface LibraryView {
  readonly kind: LibraryKind | typeof ALL_KINDS;
  readonly origin: Origin | typeof ALL_ORIGINS;
  /** {@link ALL_VEHICLES}, {@link UNKNOWN_VEHICLE} or one VIN as storage keeps it. */
  readonly vehicle: string;
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
  vehicle: ALL_VEHICLES,
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
  readonly vehicle: string | undefined;
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
    vehicle: search.vehicle ?? DEFAULT_VIEW.vehicle,
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
    vehicle: view.vehicle === ALL_VEHICLES ? undefined : view.vehicle,
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
  { value: "vehicle", label: "Vehicle" },
  { value: "origin", label: "Origin" },
  { value: "day", label: "Day" },
];

/** The grouping for a value of the group-by select, which offers every grouping and {@link NO_GROUPING}. */
export function groupingChoice(value: string): Grouping | undefined {
  return GROUPINGS.find((grouping) => grouping === value);
}

/** What items of no known VIN are called, as a filter choice, a group's heading and a row's vehicle. */
export const UNKNOWN_VEHICLE_LABEL = "Unknown vehicle";

/** A short name for each VIN whose car a profile names, such as the profile a VIN's maker and model match. */
export type VehicleLabels = ReadonlyMap<string, string>;

/** How a VIN reads in a filter choice or a group's heading: the VIN, then its short name where one is known. */
export function vehicleText(vin: string | null, labels: VehicleLabels): string {
  if (vin === null) return UNKNOWN_VEHICLE_LABEL;
  const label = labels.get(vin);
  return label === undefined ? vin : `${vin} (${label})`;
}

/** The distinct VINs of `items`, in order. */
export function vinsOf(items: readonly LibraryItem[]): string[] {
  return [...new Set(items.flatMap((item) => (item.vin === null ? [] : [item.vin])))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

/**
 * The choices of the vehicle filter: every vehicle, each VIN among `items` with its short name, then the items of no known VIN. A VIN the address chose that no item has is offered too, so the filter still shows what it holds.
 */
export function vehicleOptions(
  items: readonly LibraryItem[],
  labels: VehicleLabels,
  chosen: string,
): SelectOption[] {
  const vins = vinsOf(items);
  if (chosen !== ALL_VEHICLES && chosen !== UNKNOWN_VEHICLE && !vins.includes(chosen)) {
    vins.push(chosen);
  }
  return [
    { value: ALL_VEHICLES, label: "All" },
    ...vins.map((vin) => ({ value: vin, label: vehicleText(vin, labels) })),
    { value: UNKNOWN_VEHICLE, label: UNKNOWN_VEHICLE_LABEL },
  ];
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
  return [
    KIND_LABELS[item.kind],
    item.id,
    profileText(item),
    item.vin ?? UNKNOWN_VEHICLE_LABEL,
    ORIGIN_LABELS[item.origin],
    details,
  ]
    .join(" ")
    .toLowerCase();
}

/** Whether `item` is of the vehicle `vehicle` chooses. */
function vehicleShown(item: LibraryItem, vehicle: string): boolean {
  if (vehicle === ALL_VEHICLES) return true;
  if (vehicle === UNKNOWN_VEHICLE) return item.vin === null;
  return item.vin === vehicle;
}

/** The items `view`'s vehicle, search and date range let through, in their order; the kind and origin filters are applied when the items are read. */
export function shownItems(items: readonly LibraryItem[], view: LibraryView): LibraryItem[] {
  const words = view.search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return items.filter((item) => {
    if (!vehicleShown(item, view.vehicle)) return false;
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

/** Compares two VINs, a known one before an unknown one, so the items of no known VIN come last. */
function byVin(a: string | null, b: string | null): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return a.localeCompare(b, "en");
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
  labels: VehicleLabels,
): {
  readonly key: string;
  readonly label: string;
  readonly rank: (other: LibraryItem) => number;
} {
  switch (group) {
    case "kind":
      return {
        key: item.kind,
        label: KIND_PLURALS[item.kind],
        rank: (other) => LIBRARY_KINDS.indexOf(item.kind) - LIBRARY_KINDS.indexOf(other.kind),
      };
    case "vehicle":
      return {
        key: item.vin ?? UNKNOWN_VEHICLE,
        label: vehicleText(item.vin, labels),
        rank: (other) => byVin(item.vin, other.vin),
      };
    case "origin":
      return {
        key: item.origin,
        label: ORIGIN_LABELS[item.origin],
        rank: (other) => ORIGINS.indexOf(item.origin) - ORIGINS.indexOf(other.origin),
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
      return { key, label, rank: (other) => Date.parse(dayOf(other.at)) - Date.parse(key) };
    }
  }
}

/** The column whose sort orders each grouping's groups; the vehicles have no column of their own, so they always come in the VINs' order. */
const GROUP_COLUMNS: Readonly<Record<Grouping, SortColumn | undefined>> = {
  kind: "kind",
  vehicle: undefined,
  origin: "origin",
  day: "date",
};

/**
 * The sorted `items` in groups by `group`, each group keeping their order. When `sort` is by the column the grouping follows (the kind, the origin or the date), the groups come in that order; otherwise they come in the kinds' or the origins' own order, or newest day first. Vehicles always come in the VINs' order, the items of no known VIN last. A vehicle group's heading is its VIN with the short name `labels` gives it.
 */
export function groupItems(
  items: readonly LibraryItem[],
  group: Grouping,
  sort: LibrarySort,
  labels: VehicleLabels,
): DataTableGroup<LibraryItem>[] {
  const groups = new Map<
    string,
    { label: string; first: LibraryItem; rank: (other: LibraryItem) => number; rows: LibraryItem[] }
  >();
  for (const item of items) {
    const { key, label, rank } = groupOf(item, group, labels);
    const found = groups.get(key);
    if (found === undefined) groups.set(key, { label, first: item, rank, rows: [item] });
    else found.rows.push(item);
  }
  const ordered = [...groups].map(([key, found]) => ({ key, ...found }));
  if (sort.column !== GROUP_COLUMNS[group]) ordered.sort((a, b) => a.rank(b.first));
  return ordered.map(({ key, label, rows }) => ({ key, label, rows }));
}
