import type { Origin } from "obd-read";
import { describe, expect, it } from "vitest";
import { captureItem, reportItem, runItem, type LibraryItem } from "../src/library/items";
import {
  DEFAULT_VIEW,
  groupItems,
  shownItems,
  sortItems,
  toggleSort,
  viewFromSearch,
  viewToSearch,
  type Grouping,
  type LibraryView,
} from "../src/library/view";
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

const ITEMS: readonly LibraryItem[] = [
  report("r1", Date.UTC(2026, 10, 14, 9), "local", "Own scan"),
  capture("c1", Date.UTC(2026, 10, 15, 10), "imported"),
  run("u1", Date.UTC(2026, 10, 16, 8), "shared", "generic-obd2"),
  run("u2", Date.UTC(2026, 10, 16, 20), "local", "mercedes-w211"),
];

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
      groupItems(sortItems(ITEMS, DEFAULT_VIEW.sort), grouping, DEFAULT_VIEW.sort).map((group) => [
        group.label,
        ids(group.rows),
      ]);
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
      groupItems(sortItems(ITEMS, sort), "day", sort).map((group) => group.key);
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
});

describe("the Library view in the address", () => {
  it("leaves every default out of the address", () => {
    expect(viewToSearch(DEFAULT_VIEW)).toEqual({
      kind: undefined,
      origin: undefined,
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
      search: "w211 scan",
      from: "2026-11-01",
      to: "2026-11-16",
      sort: { column: "profile", direction: "descending" },
      group: "day",
    };
    expect(viewToSearch(chosen)).toEqual({
      kind: "run",
      origin: "shared",
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
});
