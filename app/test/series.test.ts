import { describe, expect, it } from "vitest";
import {
  VIEW_HEIGHT,
  VIEW_WIDTH,
  appendRolling,
  describeSeries,
  downsample,
  extentOf,
  foldSamples,
  formatElapsed,
  formatValue,
  fraction,
  indexAtOrBefore,
  polyline,
  seriesOf,
  stepTime,
  valueAt,
  type Point,
  type SeriesBook,
} from "../src/charts";

function ramp(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => ({ t: index * 10, v: index % 7 }));
}

describe("extentOf and fraction", () => {
  it("finds the range, and none for no points", () => {
    expect(extentOf([])).toBeUndefined();
    expect(
      extentOf([
        { t: 0, v: 3 },
        { t: 1, v: -2 },
        { t: 2, v: 9 },
      ]),
    ).toEqual({ min: -2, max: 9 });
  });

  it("maps into 0..1 and centres a range with no width", () => {
    expect(fraction(5, 0, 10)).toBe(0.5);
    expect(fraction(0, 0, 10)).toBe(0);
    expect(fraction(7, 7, 7)).toBe(0.5);
  });
});

describe("downsample", () => {
  it("returns a series within the limit unchanged", () => {
    const points = ramp(10);
    expect(downsample(points, 10)).toBe(points);
  });

  it("bounds the length and keeps a lone spike and a lone dip", () => {
    const points = ramp(10_000).map((point) => ({ ...point, v: 50 }));
    points[4321] = { t: 43_210, v: 500 };
    points[7777] = { t: 77_770, v: -500 };
    const thinned = downsample(points, 200);
    expect(thinned.length).toBeLessThanOrEqual(200);
    expect(extentOf(thinned)).toEqual({ min: -500, max: 500 });
  });

  it("keeps time order and only readings that were in the series", () => {
    const points = ramp(5000);
    const thinned = downsample(points, 100);
    const times = thinned.map(({ t }) => t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const point of thinned) expect(points).toContain(point);
  });

  it("keeps the extremes when thinning an already thinned series again", () => {
    const points = ramp(20_000).map((point) => ({ ...point, v: 1 }));
    points[12_345] = { t: 123_450, v: 99 };
    expect(extentOf(downsample(downsample(points, 1000), 100))?.max).toBe(99);
  });
});

describe("cursor lookup", () => {
  const points: Point[] = [
    { t: 10, v: 1 },
    { t: 20, v: 2 },
    { t: 30, v: 3 },
  ];

  it("finds the last reading at or before a time", () => {
    expect(indexAtOrBefore(points, 5)).toBe(-1);
    expect(indexAtOrBefore(points, 10)).toBe(0);
    expect(indexAtOrBefore(points, 29)).toBe(1);
    expect(indexAtOrBefore(points, 1000)).toBe(2);
    expect(indexAtOrBefore([], 1)).toBe(-1);
  });

  it("holds a value until the next reading and has none before the first", () => {
    expect(valueAt(points, 5)).toBeUndefined();
    expect(valueAt(points, 25)).toEqual({ t: 20, v: 2 });
  });

  it("steps to the next and previous reading and stops at the ends", () => {
    expect(stepTime(points, 10, 1)).toBe(20);
    expect(stepTime(points, 25, 1)).toBe(30);
    expect(stepTime(points, 30, 1)).toBe(30);
    expect(stepTime(points, 20, -1)).toBe(10);
    expect(stepTime(points, 25, -1)).toBe(20);
    expect(stepTime(points, 10, -1)).toBe(10);
    expect(stepTime([], 0, 1)).toBeUndefined();
  });
});

describe("polyline", () => {
  it("puts the start at the left, the highest value at the top and the end at the right", () => {
    const path = polyline(
      [
        { t: 0, v: 0 },
        { t: 10, v: 10 },
      ],
      [0, 10],
      { min: 0, max: 10 },
    );
    expect(path).toBe(`0.0,${VIEW_HEIGHT.toFixed(1)} ${VIEW_WIDTH.toFixed(1)},0.0`);
  });
});

describe("formatting and description", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00.0");
    expect(formatElapsed(12_340)).toBe("0:12.3");
    expect(formatElapsed(61_000)).toBe("1:01.0");
    expect(formatElapsed(3_723_000)).toBe("1:02:03.0");
    expect(formatElapsed(-5)).toBe("0:00.0");
  });

  it("trims trailing zeros", () => {
    expect(formatValue(1.5)).toBe("1.5");
    expect(formatValue(2)).toBe("2");
    expect(formatValue(0.12345)).toBe("0.123");
    expect(formatValue(1234.56)).toBe("1234.6");
  });

  it("describes a series in words, with its range and ends", () => {
    const text = describeSeries("engine speed", "rpm", [
      { t: 0, v: 800 },
      { t: 2000, v: 3000 },
      { t: 4000, v: 900 },
    ]);
    expect(text).toContain("engine speed: 3 readings from 0:00.0 to 0:04.0");
    expect(text).toContain("lowest 800 rpm, highest 3000 rpm");
    expect(text).toContain("starting at 800 rpm and ending at 900 rpm");
    expect(describeSeries("x", "", [])).toBe("x: no readings.");
  });
});

describe("foldSamples", () => {
  const sample = (signal: string, timestamp: number, value: number | string) => ({
    signal,
    unit: "u",
    timestamp,
    value,
  });

  it("groups by signal and unit from an origin, skipping and counting text", () => {
    const book: SeriesBook = new Map();
    const skipped = foldSamples(
      book,
      [sample("b", 1100, 2), sample("a", 1000, 1), sample("a", 1200, "n/a"), sample("a", 1300, 3)],
      1000,
      100,
    );
    expect(skipped).toBe(1);
    expect(seriesOf(book).map(({ signal, points }) => [signal, points])).toEqual([
      [
        "a",
        [
          { t: 0, v: 1 },
          { t: 300, v: 3 },
        ],
      ],
      ["b", [{ t: 100, v: 2 }]],
    ]);
  });

  it("holds a bounded number of points across any number of pages and keeps the extremes", () => {
    const book: SeriesBook = new Map();
    const limit = 50;
    const pageSize = 500;
    for (let page = 0; page < 200; page += 1) {
      const samples = Array.from({ length: pageSize }, (_, index) => {
        const n = page * pageSize + index;
        return sample("s", n, n === 77_777 ? 9999 : (n % 13) - 6);
      });
      foldSamples(book, samples, 0, limit);
      expect(book.get("s\u0000u")?.points.length ?? 0).toBeLessThanOrEqual(limit * 2 + pageSize);
    }
    const points = seriesOf(book)[0]?.points ?? [];
    expect(points.length).toBeLessThanOrEqual(limit * 2 + pageSize);
    expect(extentOf(points)).toEqual({ min: -6, max: 9999 });
  });
});

describe("appendRolling", () => {
  it("keeps the newest readings per signal, ignores repeats and text", () => {
    let history = appendRolling(new Map(), [{ signal: "a", timestamp: 1, value: 10 }], 3);
    history = appendRolling(history, [{ signal: "a", timestamp: 1, value: 10 }], 3);
    expect(history.get("a")).toEqual([{ t: 1, v: 10 }]);
    for (let t = 2; t <= 6; t += 1) {
      history = appendRolling(
        history,
        [
          { signal: "a", timestamp: t, value: t * 10 },
          { signal: "text", timestamp: t, value: "on" },
        ],
        3,
      );
    }
    expect(history.get("a")).toEqual([
      { t: 4, v: 40 },
      { t: 5, v: 50 },
      { t: 6, v: 60 },
    ]);
    expect(history.has("text")).toBe(false);
  });
});
