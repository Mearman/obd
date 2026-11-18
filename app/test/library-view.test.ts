import type { Origin } from "obd-read";
import { describe, expect, it } from "vitest";
import { captureItem, reportItem, runItem, type LibraryItem } from "../src/library/items";
import {
  ALL_VEHICLES,
  DEFAULT_VIEW,
  UNKNOWN_VEHICLE,
  groupItems,
  shownItems,
  sortItems,
  toggleSort,
  vehicleOptions,
  vehicleText,
  viewFromSearch,
  viewToSearch,
  vinsOf,
  type Grouping,
  type LibraryView,
  type VehicleLabels,
} from "../src/library/view";
import { vehicleLabels } from "../src/library/vehicle-labels";
import { builtinProfiles, loadBuiltinProfile } from "obd-read/profiles";
import { searchSchema } from "../src/router/search";

function report(
  id: string,
  at: number,
  origin: Origin,
  label: string,
  vin: string | null = null,
): LibraryItem {
  return reportItem({
    id,
    profile: "mercedes-w211",
    adapter: "simulator://mercedes-w211",
    takenAt: at,
    label,
    origin,
    vin,
  });
}

function run(
  id: string,
  at: number,
  origin: Origin,
  profile: string,
  vin: string | null = null,
): LibraryItem {
  return runItem(
    {
      id,
      profile,
      adapter: "simulator://generic",
      startedAt: at,
      stoppedAt: at + 1000,
      notes: "",
      origin,
      vin,
    },
    1,
  );
}

function capture(id: string, at: number, origin: Origin, vin: string | null = null): LibraryItem {
  return captureItem({
    id,
    startedAt: at,
    endedAt: at + 1000,
    kind: "scan",
    profile: null,
    complete: true,
    description: "Workshop capture",
    adapter: "ELM327",
    exchanges: 1,
    units: [],
    origin,
    vin,
  });
}

/** The invented VINs of the two cars the items were read from. */
const E_CLASS = "WDB2110202B000001";
const POLO = "WVWZZZ6RZAY000002";

const ITEMS: readonly LibraryItem[] = [
  report("r1", Date.UTC(2026, 10, 14, 9), "local", "Own scan", E_CLASS),
  capture("c1", Date.UTC(2026, 10, 15, 10), "imported"),
  run("u1", Date.UTC(2026, 10, 16, 8), "shared", "generic-obd2", POLO),
  run("u2", Date.UTC(2026, 10, 16, 20), "local", "mercedes-w211", E_CLASS),
];

/** The short names a profile gives the VINs: only the E-Class has one. */
const LABELS: VehicleLabels = new Map([[E_CLASS, "mercedes-w211"]]);

const ids = (items: readonly LibraryItem[]): string[] => items.map((item) => item.id);

function view(change: Partial<LibraryView>): LibraryView {
  return { ...DEFAULT_VIEW, ...change };
}

describe("the Library's search and date range", () => {
  it("keeps every item, in its order, for the default view", () => {
    expect(ids(shownItems(ITEMS, DEFAULT_VIEW))).toEqual(["r1", "c1", "u1", "u2"]);
  });

  it("matches every word of the search, in any case, against what a row shows", () => {
    expect(ids(shownItems(ITEMS, view({ search: "own SCAN" })))).toEqual(["r1"]);
    expect(ids(shownItems(ITEMS, view({ search: "w211" })))).toEqual(["r1", "u2"]);
    expect(ids(shownItems(ITEMS, view({ search: "imported" })))).toEqual(["c1"]);
    expect(ids(shownItems(ITEMS, view({ search: "run here" })))).toEqual(["u2"]);
    expect(ids(shownItems(ITEMS, view({ search: "no profile" })))).toEqual(["c1", "u1"]);
    expect(ids(shownItems(ITEMS, view({ search: "   " })))).toHaveLength(4);
    expect(ids(shownItems(ITEMS, view({ search: "nothing like it" })))).toEqual([]);
  });

  it("matches the VIN, in any case, and the items of no known VIN as an unknown vehicle", () => {
    expect(ids(shownItems(ITEMS, view({ search: "wdb2110202b" })))).toEqual(["r1", "u2"]);
    expect(ids(shownItems(ITEMS, view({ search: "unknown vehicle" })))).toEqual(["c1"]);
  });
});

describe("the Library's vehicle filter", () => {
  it("keeps the items of one VIN, of no known VIN, or of every vehicle", () => {
    expect(ids(shownItems(ITEMS, view({ vehicle: E_CLASS })))).toEqual(["r1", "u2"]);
    expect(ids(shownItems(ITEMS, view({ vehicle: POLO })))).toEqual(["u1"]);
    expect(ids(shownItems(ITEMS, view({ vehicle: UNKNOWN_VEHICLE })))).toEqual(["c1"]);
    expect(ids(shownItems(ITEMS, view({ vehicle: ALL_VEHICLES })))).toHaveLength(4);
    expect(ids(shownItems(ITEMS, view({ vehicle: E_CLASS, search: "run" })))).toEqual(["u2"]);
  });

  it("offers every vehicle, each distinct VIN with its short name, then the unknown vehicle", () => {
    expect(vehicleOptions(ITEMS, LABELS, ALL_VEHICLES)).toEqual([
      { value: ALL_VEHICLES, label: "All" },
      { value: E_CLASS, label: `${E_CLASS} (mercedes-w211)` },
      { value: POLO, label: POLO },
      { value: UNKNOWN_VEHICLE, label: "Unknown vehicle" },
    ]);
  });

  it("still offers a VIN the address chose that no item has, so the filter shows it", () => {
    expect(
      vehicleOptions(ITEMS, LABELS, "VF1AAAAAA00000003").map((option) => option.value),
    ).toEqual([ALL_VEHICLES, E_CLASS, POLO, "VF1AAAAAA00000003", UNKNOWN_VEHICLE]);
    expect(vinsOf(ITEMS)).toEqual([E_CLASS, POLO]);
  });

  it("reads a VIN with its short name, and no VIN as the unknown vehicle", () => {
    expect(vehicleText(E_CLASS, LABELS)).toBe(`${E_CLASS} (mercedes-w211)`);
    expect(vehicleText(POLO, LABELS)).toBe(POLO);
    expect(vehicleText(null, LABELS)).toBe("Unknown vehicle");
  });

  it("keeps the items of each UTC day from the first date to the last, both included", () => {
    expect(ids(shownItems(ITEMS, view({ from: "2026-11-15" })))).toEqual(["c1", "u1", "u2"]);
    expect(ids(shownItems(ITEMS, view({ to: "2026-11-15" })))).toEqual(["r1", "c1"]);
    expect(ids(shownItems(ITEMS, view({ from: "2026-11-16", to: "2026-11-16" })))).toEqual([
      "u1",
      "u2",
    ]);
  });
});

describe("sorting the Library", () => {
  it("sorts by each column both ways, newest first among equals", () => {
    const by = (column: LibraryView["sort"]["column"], direction: "ascending" | "descending") =>
      ids(sortItems(ITEMS, { column, direction }));
    expect(by("date", "descending")).toEqual(["u2", "u1", "c1", "r1"]);
    expect(by("date", "ascending")).toEqual(["r1", "c1", "u1", "u2"]);
    // By the kind as it reads: Capture, Report, Run.
    expect(by("kind", "ascending")).toEqual(["c1", "r1", "u2", "u1"]);
    expect(by("kind", "descending")).toEqual(["u2", "u1", "r1", "c1"]);
    // By the origin as it reads: Imported, Read here, Shared.
    expect(by("origin", "ascending")).toEqual(["c1", "u2", "r1", "u1"]);
    // By the profile as it reads: the generic title, "mercedes-w211", then "no profile".
    expect(by("profile", "ascending")).toEqual(["u1", "u2", "r1", "c1"]);
    expect(by("profile", "descending")).toEqual(["c1", "u2", "r1", "u1"]);
    // By the VIN, the items of no known VIN last whichever way.
    expect(by("vehicle", "ascending")).toEqual(["u2", "r1", "u1", "c1"]);
    expect(by("vehicle", "descending")).toEqual(["u1", "u2", "r1", "c1"]);
  });

  it("turns the sorted column around, and starts another ascending", () => {
    expect(toggleSort({ column: "date", direction: "descending" }, "date")).toEqual({
      column: "date",
      direction: "ascending",
    });
    expect(toggleSort({ column: "date", direction: "ascending" }, "date")).toEqual({
      column: "date",
      direction: "descending",
    });
    expect(toggleSort({ column: "date", direction: "descending" }, "kind")).toEqual({
      column: "kind",
      direction: "ascending",
    });
  });
});

describe("grouping the Library", () => {
  it("groups by kind, by origin and by UTC day, each group keeping the sort", () => {
    const groups = (grouping: Grouping) =>
      groupItems(sortItems(ITEMS, DEFAULT_VIEW.sort), grouping, DEFAULT_VIEW.sort, LABELS).map(
        (group) => [group.label, ids(group.rows)],
      );
    expect(groups("kind")).toEqual([
      ["Runs", ["u2", "u1"]],
      ["Captures", ["c1"]],
      ["Reports", ["r1"]],
    ]);
    expect(groups("origin")).toEqual([
      ["Read here", ["u2", "r1"]],
      ["Shared", ["u1"]],
      ["Imported", ["c1"]],
    ]);
    expect(groups("day")).toEqual([
      ["16 November 2026", ["u2", "u1"]],
      ["15 November 2026", ["c1"]],
      ["14 November 2026", ["r1"]],
    ]);
  });

  it("orders the days by the date sort when sorting by date, newest first otherwise", () => {
    const days = (sort: LibraryView["sort"]) =>
      groupItems(sortItems(ITEMS, sort), "day", sort, LABELS).map((group) => group.key);
    expect(days({ column: "date", direction: "ascending" })).toEqual([
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
    ]);
    expect(days({ column: "kind", direction: "ascending" })).toEqual([
      "2026-11-16",
      "2026-11-15",
      "2026-11-14",
    ]);
  });

  it("groups by vehicle under the VIN and its short name, the unknown vehicle last", () => {
    const vehicles = (sort: LibraryView["sort"]) =>
      groupItems(sortItems(ITEMS, sort), "vehicle", sort, LABELS).map((group) => [
        group.key,
        group.label,
        ids(group.rows),
      ]);
    expect(vehicles(DEFAULT_VIEW.sort)).toEqual([
      [E_CLASS, `${E_CLASS} (mercedes-w211)`, ["u2", "r1"]],
      [POLO, POLO, ["u1"]],
      [UNKNOWN_VEHICLE, "Unknown vehicle", ["c1"]],
    ]);
    // By another column, the vehicles come in the VINs' order, each group keeping the sort.
    expect(vehicles({ column: "date", direction: "ascending" })).toEqual([
      [E_CLASS, `${E_CLASS} (mercedes-w211)`, ["r1", "u2"]],
      [POLO, POLO, ["u1"]],
      [UNKNOWN_VEHICLE, "Unknown vehicle", ["c1"]],
    ]);
    // Sorted by the vehicle, the groups follow that sort, the unknown vehicle still last.
    expect(vehicles({ column: "vehicle", direction: "descending" }).map(([key]) => key)).toEqual([
      POLO,
      E_CLASS,
      UNKNOWN_VEHICLE,
    ]);
  });
});

describe("the Library view in the address", () => {
  it("leaves every default out of the address", () => {
    expect(viewToSearch(DEFAULT_VIEW)).toEqual({
      kind: undefined,
      origin: undefined,
      vehicle: undefined,
      q: undefined,
      from: undefined,
      to: undefined,
      sort: undefined,
      group: undefined,
    });
  });

  it("reads back every part it writes", () => {
    const chosen: LibraryView = {
      kind: "run",
      origin: "shared",
      vehicle: E_CLASS,
      search: "w211 scan",
      from: "2026-11-01",
      to: "2026-11-16",
      sort: { column: "profile", direction: "descending" },
      group: "day",
    };
    expect(viewToSearch(chosen)).toEqual({
      kind: "run",
      origin: "shared",
      vehicle: E_CLASS,
      q: "w211 scan",
      from: "2026-11-01",
      to: "2026-11-16",
      sort: "-profile",
      group: "day",
    });
    expect(viewFromSearch(searchSchema.parse(viewToSearch(chosen)))).toEqual(chosen);
    expect(viewFromSearch(searchSchema.parse({ sort: "kind" })).sort).toEqual({
      column: "kind",
      direction: "ascending",
    });
  });

  it("ignores a value that is not valid, keeping the rest", () => {
    const search = searchSchema.parse({
      kind: "lorry",
      origin: "moon",
      from: "16/11/2026",
      to: "2026-11-16",
      sort: "-weight",
      group: "colour",
    });
    expect(viewFromSearch(search)).toEqual({ ...DEFAULT_VIEW, to: "2026-11-16" });
  });

  it("reads a search the address holds as a number as its text", () => {
    expect(viewFromSearch(searchSchema.parse({ q: 211 })).search).toBe("211");
  });

  it("reads the vehicle and the grouping by vehicle back from the address", () => {
    const unknown = view({
      vehicle: UNKNOWN_VEHICLE,
      group: "vehicle",
      sort: { column: "vehicle", direction: "descending" },
    });
    expect(viewToSearch(unknown)).toMatchObject({
      vehicle: "unknown",
      group: "vehicle",
      sort: "-vehicle",
    });
    expect(viewFromSearch(searchSchema.parse(viewToSearch(unknown)))).toEqual(unknown);
    expect(viewFromSearch(searchSchema.parse({ vehicle: 12345 })).vehicle).toBe("12345");
    expect(viewFromSearch(searchSchema.parse({ vehicle: "" })).vehicle).toBe(ALL_VEHICLES);
  });
});

describe("the short names of the vehicles", () => {
  it("names a VIN by the shipped profile its maker and model match, and leaves a maker match unnamed", () => {
    const profiles = builtinProfiles().map(loadBuiltinProfile);
    expect(vehicleLabels([E_CLASS, POLO, "not a vin"], profiles)).toEqual(LABELS);
  });
});
