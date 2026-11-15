import { describe, expect, it } from "vitest";
import { formatReading, formatReadingWithUnit } from "../src/format/reading";
import { SATURATED_NOTE, isSaturated } from "../src/format/saturation";
import { describeCycle } from "../src/screens/live/estimate";
import { VALUE_GROUPS, groupOf, groupRows } from "../src/screens/live/groups";
import { PRESETS, initialSelection, presetOf } from "../src/screens/live/presets";

describe("formatting a reading by its unit", () => {
  it.each([
    [25.098039215686274, "%", "25.1"],
    [-3.125, "%", "-3.1"],
    [13.333333333333334, "°C", "13"],
    [13.8, "V", "13.80"],
    [849.75, "rpm", "850"],
    [72.4, "km/h", "72"],
    [101.6, "kPa", "102"],
    [0.9981, "ratio", "0.998"],
    [1.5, "ratio", "1.500"],
    [4.2345, "g/s", "4.23"],
    [-0.04, "°C", "0"],
    [-0.04, "%", "0.0"],
  ])("shows %s %s as %s", (value, unit, shown) => {
    expect(formatReading(value, unit)).toBe(shown);
  });

  it("trims a number of no known unit and passes text through", () => {
    expect(formatReading(2, "")).toBe("2");
    expect(formatReading(0.12345, "widgets")).toBe("0.123");
    expect(formatReading("closed loop", "")).toBe("closed loop");
    expect(formatReadingWithUnit(25.098039215686274, "%")).toBe("25.1 %");
    expect(formatReadingWithUnit(7, "")).toBe("7");
  });
});

describe("counters at their field's maximum", () => {
  it("are flagged only at the maximum of a known counter", () => {
    expect(isSaturated("time since codes cleared", 65_535)).toBe(true);
    expect(isSaturated("warm-ups since codes cleared", 255)).toBe(true);
    expect(isSaturated("warm-ups since codes cleared", 254)).toBe(false);
    expect(isSaturated("engine speed", 65_535)).toBe(false);
    expect(isSaturated("stored fault codes", "65535")).toBe(false);
    expect(SATURATED_NOTE).toContain("real value is higher");
  });
});

describe("grouping values under headings", () => {
  it.each([
    ["engine speed", "Engine"],
    ["coolant temperature", "Engine"],
    ["short-term fuel trim bank 1", "Fuel and mixture"],
    ["oxygen sensor 1 voltage", "Fuel and mixture"],
    ["fuel system 1 status", "Fuel and mixture"],
    ["catalyst temperature bank 1 sensor 1", "Emissions and catalyst"],
    ["commanded EGR", "Emissions and catalyst"],
    ["control module voltage", "Electrical"],
    ["warm-ups since codes cleared", "Counters and status"],
    ["stored fault codes", "Counters and status"],
  ])("lists %s under %s", (label, heading) => {
    expect(groupOf(label)).toBe(heading);
  });

  it("orders the headings and drops empty ones", () => {
    const rows = ["warm-ups since codes cleared", "engine speed", "commanded EGR", "vehicle speed"];
    const grouped = groupRows(rows, (row) => row);
    expect(grouped.map((entry) => entry.group)).toEqual([
      "Engine",
      "Emissions and catalyst",
      "Counters and status",
    ]);
    expect(grouped[0]?.rows).toEqual(["engine speed", "vehicle speed"]);
    expect(VALUE_GROUPS).toHaveLength(5);
  });
});

describe("the presets", () => {
  const supported = [
    "engine-speed",
    "vehicle-speed",
    "engine-load",
    "throttle-position",
    "coolant-temperature",
    "intake-air-temperature",
    "short-fuel-trim-b1",
    "long-fuel-trim-b1",
    "o2-sensor-1",
    "lambda-sensor-2",
    "fuel-system-status",
    "fuel-level",
  ];
  const named = (label: string) => PRESETS.find((preset) => preset.label === label);

  it("select what their names say among what the car supports", () => {
    expect(named("Engine")?.select(supported)).toEqual([
      "engine-speed",
      "vehicle-speed",
      "engine-load",
      "throttle-position",
      "coolant-temperature",
    ]);
    expect(named("Fuel and mixture")?.select(supported)).toEqual([
      "short-fuel-trim-b1",
      "long-fuel-trim-b1",
      "o2-sensor-1",
      "lambda-sensor-2",
      "fuel-system-status",
    ]);
    expect(named("Everything")?.select(supported)).toEqual(supported);
    expect(named("Engine")?.select(["engine-speed"])).toEqual(["engine-speed"]);
  });

  it("are recognised from a selection in any order", () => {
    const engine = [...(named("Engine")?.select(supported) ?? [])].reverse();
    expect(presetOf(engine, supported)?.label).toBe("Engine");
    expect(presetOf(["engine-speed", "fuel-level"], supported)).toBeUndefined();
  });

  it("start from what was remembered and still supported, else Engine, else everything", () => {
    expect(initialSelection(["fuel-level", "gone"], supported)).toEqual(["fuel-level"]);
    expect(initialSelection(undefined, supported)).toEqual(named("Engine")?.select(supported));
    expect(initialSelection(["gone"], ["fuel-level"])).toEqual(["fuel-level"]);
  });
});

describe("the estimate of a round", () => {
  it("is words from the count and the measured time per request", () => {
    expect(describeCycle(0, 1000)).toBe("Choose at least one value.");
    expect(describeCycle(5, 20)).toBe(
      "A round of 5 values at about 20 ms per request takes under a second.",
    );
    expect(describeCycle(37, 1100)).toBe(
      "A round of 37 values at about 1.1 s per request takes about 41 s.",
    );
    expect(describeCycle(1, 1000)).toContain("1 value at");
    expect(describeCycle(100, 1000)).toContain("1 min 40 s");
  });
});
