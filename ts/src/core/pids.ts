/**
 * Legislated current-data parameters (OBD-II mode 01): which bytes mean what.
 *
 * Every formula follows SAE J1979 as tabulated, with the same formulas and ranges, in
 * https://en.wikipedia.org/wiki/OBD-II_PIDs (latest snapshot:
 * https://web.archive.org/web/https://en.wikipedia.org/wiki/OBD-II_PIDs). The standard itself is
 * not freely readable, so that table is the source each decoder here was checked against. A, B, C
 * and D in the comments are the data bytes in the order the unit sends them.
 */

import { byteAt } from "./bytes.js";

/** One decoded reading: a number, or the text of an enumerated status. */
export type Value = number | string;

/** One reading a parameter yields: its label and unit. */
export interface Column {
  readonly label: string;
  readonly unit: string;
}

/**
 * One current-data parameter: how to name it and turn its data bytes into readings.
 *
 * `decode` receives at least `size` data bytes and returns one value per column.
 */
export interface Pid {
  readonly code: number;
  readonly name: string;
  readonly size: number;
  readonly columns: readonly Column[];
  readonly decode: (data: Uint8Array) => readonly Value[];
}

function word(data: Uint8Array, start = 0): number {
  return byteAt(data, start) * 256 + byteAt(data, start + 1);
}

function signedWord(data: Uint8Array): number {
  const value = word(data);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function percent(byte: number): number {
  return (byte * 100) / 255;
}

// Fuel trims are centred on 128 so they can be negative: 0 is -100 %, 128 is 0 %, 255 is +99.2 %.
function trim(byte: number): number {
  return (byte * 100) / 128 - 100;
}

function single(
  code: number,
  name: string,
  label: string,
  unit: string,
  size: number,
  decode: (data: Uint8Array) => Value,
): Pid {
  return { code, name, size, columns: [{ label, unit }], decode: (data) => [decode(data)] };
}

/** Fuel system status values; any other value is invalid in the standard. */
export const FUEL_SYSTEM_STATUS: ReadonlyMap<number, string> = new Map([
  [0, "off"],
  [1, "open loop, engine too cold"],
  [2, "closed loop, using oxygen sensor feedback"],
  [4, "open loop, engine load or deceleration fuel cut"],
  [8, "open loop, system failure"],
  [16, "closed loop, fault in the feedback system"],
]);

/** Commanded secondary air status values. */
export const SECONDARY_AIR_STATUS: ReadonlyMap<number, string> = new Map([
  [1, "upstream"],
  [2, "downstream of the catalytic converter"],
  [4, "outside atmosphere or off"],
  [8, "pump commanded on for diagnostics"],
]);

/** The OBD requirement the vehicle is designed to. */
export const OBD_STANDARD: ReadonlyMap<number, string> = new Map([
  [1, "OBD-II (CARB)"],
  [2, "OBD (EPA)"],
  [3, "OBD and OBD-II"],
  [4, "OBD-I"],
  [5, "not OBD compliant"],
  [6, "EOBD"],
  [7, "EOBD and OBD-II"],
  [8, "EOBD and OBD"],
  [9, "EOBD, OBD and OBD-II"],
  [10, "JOBD"],
  [11, "JOBD and OBD-II"],
  [12, "JOBD and EOBD"],
  [13, "JOBD, EOBD and OBD-II"],
]);

function enumerated(table: ReadonlyMap<number, string>): (data: Uint8Array) => string {
  return (data) => table.get(byteAt(data, 0)) ?? `unlisted value ${String(byteAt(data, 0))}`;
}

function fuelSystem(data: Uint8Array): readonly Value[] {
  // The second byte describes fuel system 2 and is zero when the car has only one.
  const secondByte = byteAt(data, 1);
  const second =
    secondByte === 0 ? "not fitted" : (FUEL_SYSTEM_STATUS.get(secondByte) ?? "invalid");
  return [FUEL_SYSTEM_STATUS.get(byteAt(data, 0)) ?? "invalid", second];
}

function oxygenVoltageAndTrim(sensor: number, code: number): Pid {
  return {
    code,
    name: `o2-sensor-${String(sensor)}`,
    size: 2,
    columns: [
      { label: `oxygen sensor ${String(sensor)} voltage`, unit: "V" },
      { label: `oxygen sensor ${String(sensor)} short-term fuel trim`, unit: "%" },
    ],
    decode: (data) => [
      byteAt(data, 0) / 200,
      // B is 0xFF when the sensor takes no part in the short-term fuel trim.
      byteAt(data, 1) === 0xff ? "not used" : trim(byteAt(data, 1)),
    ],
  };
}

function wideRangeRatioAndVoltage(sensor: number, code: number): Pid {
  return {
    code,
    name: `lambda-sensor-${String(sensor)}`,
    size: 4,
    columns: [
      { label: `oxygen sensor ${String(sensor)} equivalence ratio`, unit: "ratio" },
      { label: `oxygen sensor ${String(sensor)} voltage`, unit: "V" },
    ],
    decode: (data) => [(word(data) * 2) / 65536, (word(data, 2) * 8) / 65536],
  };
}

function wideRangeRatioAndCurrent(sensor: number, code: number): Pid {
  return {
    code,
    name: `lambda-current-sensor-${String(sensor)}`,
    size: 4,
    columns: [
      { label: `oxygen sensor ${String(sensor)} equivalence ratio`, unit: "ratio" },
      { label: `oxygen sensor ${String(sensor)} current`, unit: "mA" },
    ],
    decode: (data) => [(word(data) * 2) / 65536, word(data, 2) / 256 - 128],
  };
}

function sensors(build: (sensor: number, code: number) => Pid, firstCode: number): Pid[] {
  return Array.from({ length: 8 }, (_, index) => build(index + 1, firstCode + index + 1));
}

function buildTable(): ReadonlyMap<number, Pid> {
  const pids: Pid[] = [
    {
      code: 0x03,
      name: "fuel-system-status",
      size: 2,
      columns: [
        { label: "fuel system 1 status", unit: "" },
        { label: "fuel system 2 status", unit: "" },
      ],
      decode: fuelSystem,
    },
    single(0x04, "engine-load", "engine load", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x05, "coolant-temperature", "coolant temperature", "°C", 1, (d) => byteAt(d, 0) - 40),
    single(0x06, "short-fuel-trim-b1", "short-term fuel trim bank 1", "%", 1, (d) =>
      trim(byteAt(d, 0)),
    ),
    single(0x07, "long-fuel-trim-b1", "long-term fuel trim bank 1", "%", 1, (d) =>
      trim(byteAt(d, 0)),
    ),
    single(0x08, "short-fuel-trim-b2", "short-term fuel trim bank 2", "%", 1, (d) =>
      trim(byteAt(d, 0)),
    ),
    single(0x09, "long-fuel-trim-b2", "long-term fuel trim bank 2", "%", 1, (d) =>
      trim(byteAt(d, 0)),
    ),
    single(0x0a, "fuel-pressure", "fuel pressure (gauge)", "kPa", 1, (d) => byteAt(d, 0) * 3),
    single(0x0b, "intake-pressure", "intake manifold pressure", "kPa", 1, (d) => byteAt(d, 0)),
    single(0x0c, "engine-speed", "engine speed", "rpm", 2, (d) => word(d) / 4),
    single(0x0d, "vehicle-speed", "vehicle speed", "km/h", 1, (d) => byteAt(d, 0)),
    single(
      0x0e,
      "timing-advance",
      "timing advance",
      "° before TDC",
      1,
      (d) => byteAt(d, 0) / 2 - 64,
    ),
    single(
      0x0f,
      "intake-air-temperature",
      "intake air temperature",
      "°C",
      1,
      (d) => byteAt(d, 0) - 40,
    ),
    single(0x10, "air-flow", "air flow rate", "g/s", 2, (d) => word(d) / 100),
    single(0x11, "throttle-position", "throttle position", "%", 1, (d) => percent(byteAt(d, 0))),
    single(
      0x12,
      "secondary-air",
      "commanded secondary air",
      "",
      1,
      enumerated(SECONDARY_AIR_STATUS),
    ),
    ...sensors(oxygenVoltageAndTrim, 0x13),
    single(0x1c, "obd-standard", "OBD standard", "", 1, enumerated(OBD_STANDARD)),
    single(0x1f, "run-time", "run time since engine start", "s", 2, (d) => word(d)),
    single(0x21, "distance-with-lamp", "distance with warning lamp on", "km", 2, (d) => word(d)),
    single(
      0x22,
      "fuel-rail-pressure",
      "fuel rail pressure (relative to manifold)",
      "kPa",
      2,
      (d) => 0.079 * word(d),
    ),
    single(
      0x23,
      "fuel-rail-gauge-pressure",
      "fuel rail pressure (gauge)",
      "kPa",
      2,
      (d) => 10 * word(d),
    ),
    ...sensors(wideRangeRatioAndVoltage, 0x23),
    single(0x2c, "egr-commanded", "commanded EGR", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x2d, "egr-error", "EGR error", "%", 1, (d) => trim(byteAt(d, 0))),
    single(0x2e, "purge-commanded", "commanded evaporative purge", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(0x2f, "fuel-level", "fuel tank level", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x30, "warm-ups", "warm-ups since codes cleared", "", 1, (d) => byteAt(d, 0)),
    single(0x31, "distance-since-clear", "distance since codes cleared", "km", 2, (d) => word(d)),
    single(
      0x32,
      "evap-vapour-pressure",
      "evaporative system vapour pressure",
      "Pa",
      2,
      (d) => signedWord(d) / 4,
    ),
    single(0x33, "barometric-pressure", "barometric pressure", "kPa", 1, (d) => byteAt(d, 0)),
    ...sensors(wideRangeRatioAndCurrent, 0x33),
    single(
      0x3c,
      "catalyst-temperature-b1s1",
      "catalyst temperature bank 1 sensor 1",
      "°C",
      2,
      (d) => word(d) / 10 - 40,
    ),
    single(
      0x3d,
      "catalyst-temperature-b2s1",
      "catalyst temperature bank 2 sensor 1",
      "°C",
      2,
      (d) => word(d) / 10 - 40,
    ),
    single(
      0x3e,
      "catalyst-temperature-b1s2",
      "catalyst temperature bank 1 sensor 2",
      "°C",
      2,
      (d) => word(d) / 10 - 40,
    ),
    single(
      0x3f,
      "catalyst-temperature-b2s2",
      "catalyst temperature bank 2 sensor 2",
      "°C",
      2,
      (d) => word(d) / 10 - 40,
    ),
    single(0x42, "module-voltage", "control module voltage", "V", 2, (d) => word(d) / 1000),
    single(0x43, "absolute-load", "absolute load value", "%", 2, (d) => (word(d) * 100) / 255),
    single(
      0x44,
      "commanded-equivalence-ratio",
      "commanded equivalence ratio",
      "ratio",
      2,
      (d) => (word(d) * 2) / 65536,
    ),
    single(0x45, "relative-throttle", "relative throttle position", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(
      0x46,
      "ambient-temperature",
      "ambient air temperature",
      "°C",
      1,
      (d) => byteAt(d, 0) - 40,
    ),
    single(0x47, "throttle-b", "absolute throttle position B", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(0x48, "throttle-c", "absolute throttle position C", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(0x49, "pedal-d", "accelerator pedal position D", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x4a, "pedal-e", "accelerator pedal position E", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x4b, "pedal-f", "accelerator pedal position F", "%", 1, (d) => percent(byteAt(d, 0))),
    single(0x4c, "throttle-commanded", "commanded throttle actuator", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(0x4d, "time-with-lamp", "time run with warning lamp on", "min", 2, (d) => word(d)),
    single(0x4e, "time-since-clear", "time since codes cleared", "min", 2, (d) => word(d)),
    single(0x52, "ethanol", "ethanol fuel", "%", 1, (d) => percent(byteAt(d, 0))),
    single(
      0x53,
      "evap-absolute-pressure",
      "absolute evaporative system vapour pressure",
      "kPa",
      2,
      (d) => word(d) / 200,
    ),
    single(0x54, "evap-pressure", "evaporative system vapour pressure (signed)", "Pa", 2, (d) =>
      signedWord(d),
    ),
    single(
      0x59,
      "fuel-rail-absolute-pressure",
      "fuel rail absolute pressure",
      "kPa",
      2,
      (d) => 10 * word(d),
    ),
    single(0x5a, "pedal-relative", "relative accelerator pedal position", "%", 1, (d) =>
      percent(byteAt(d, 0)),
    ),
    single(0x5c, "oil-temperature", "engine oil temperature", "°C", 1, (d) => byteAt(d, 0) - 40),
    single(0x5d, "injection-timing", "fuel injection timing", "°", 2, (d) => word(d) / 128 - 210),
    single(0x5e, "fuel-rate", "engine fuel rate", "L/h", 2, (d) => word(d) / 20),
  ];
  return new Map(pids.map((pid) => [pid.code, pid]));
}

/** The decodable current-data parameters, by identifier. */
export const PIDS: ReadonlyMap<number, Pid> = buildTable();
