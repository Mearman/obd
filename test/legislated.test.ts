import { describe, expect, it } from "vitest";
import {
  CURRENT_DATA,
  PIDS,
  decodeMonitorTests,
  decodeReadiness,
  decodeSupportBitmap,
  formatValue,
  fromHex,
  supportedIds,
} from "../src/core/index.js";
import { Car, RECORDED } from "./helpers/recorded-car.js";
import { loadReplies } from "./helpers/transcripts.js";

function pid(code: number): NonNullable<ReturnType<typeof PIDS.get>> {
  const found = PIDS.get(code);
  if (found === undefined) throw new Error(`no parameter ${String(code)}`);
  return found;
}

it("reads the support bitmap from a recorded reply", () => {
  // The recorded reply to 0100 from a 2009 petrol hatchback.
  expect(decodeSupportBitmap(0x00, fromHex("BE3EB813"))).toEqual(
    new Set([
      ...[0x01, 0x03, 0x04, 0x05, 0x06, 0x07],
      ...[0x0b, 0x0c, 0x0d, 0x0e, 0x0f],
      ...[0x11, 0x13, 0x14, 0x15],
      ...[0x1c, 0x1f, 0x20],
    ]),
  );
});

it("follows the supported-identifier chain and stops where it ends", async () => {
  const car = new Car(loadReplies(...RECORDED));
  const supported = await supportedIds(await car.elm(), CURRENT_DATA);
  const ids = supported.get(0x7e8);
  expect(ids?.has(0x40)).toBe(true);
  expect(ids?.has(0x4e)).toBe(true);
  expect(ids?.has(0x10)).toBe(false);
  // 0140 says there is no bitmap at 0160, so none is requested.
  expect(car.core.requests).toEqual(["0100", "0120", "0140"]);
});

describe("the obd report", () => {
  it("reads only what the car supports", async () => {
    const car = new Car(loadReplies(...RECORDED));
    expect(await car.obd()).toBe(0);
    expect(car.core.requests).toContain("0104");
    expect(car.core.requests).not.toContain("0110"); // not in the bitmap, although the car was once asked
    expect(car.core.requests).not.toContain("014F");
    const modes = new Set(car.core.requests.map((request) => request.slice(0, 2)));
    expect(
      [...modes].filter((mode) => !["01", "02", "03", "06", "07", "09", "0A"].includes(mode)),
    ).toEqual([]);
  });

  it("decodes recorded values", async () => {
    const car = new Car(loadReplies(...RECORDED));
    expect(await car.obd()).toBe(0);
    const out = car.output;
    for (const line of [
      "short-term fuel trim bank 1: -2.344 %",
      "long-term fuel trim bank 1: 2.344 %",
      "timing advance: 11.5 ° before TDC",
      "throttle position: 12.941 %",
      "oxygen sensor 1 voltage: 0.095 V",
      "oxygen sensor 1 short-term fuel trim: 0 %",
      "oxygen sensor 2 voltage: 0.43 V",
      "oxygen sensor 2 short-term fuel trim: not used",
      "fuel system 1 status: closed loop, using oxygen sensor feedback",
      "fuel system 2 status: not fitted",
      "run time since engine start: 263 s",
      "fuel tank level: 34.902 %",
      "ambient air temperature: 12 °C",
      "distance with warning lamp on: 13 km",
      "warm-ups since codes cleared: 255",
      "distance since codes cleared: 49700 km",
      "time run with warning lamp on: 35 min",
      "time since codes cleared: 65535 min",
    ]) {
      expect(out).toContain(line);
    }
  });

  it("reports readiness and the calibration identifier", async () => {
    const car = new Car(loadReplies(...RECORDED));
    expect(await car.obd()).toBe(0);
    expect(car.output).toContain("readiness from 7E8 (spark ignition):");
    expect(car.output).toContain(
      "  complete: misfire, fuel system, components, catalyst, oxygen sensor, oxygen sensor heater",
    );
    expect(car.output).toContain("  not complete: none");
    expect(car.output).toContain("calibration identifier from 7E8: 0034466040150284");
    expect(car.core.requests).toContain("0904");
  });

  it("does not request the calibration identifier when the bitmap omits it", async () => {
    const replies = loadReplies(...RECORDED);
    replies.set("0900", [[0x7e8, fromHex("490040000000")]]); // only identifier 02
    const car = new Car(replies);
    expect(await car.obd()).toBe(0);
    expect(car.core.requests).not.toContain("0904");
    expect(car.output).not.toContain("calibration identifier");
  });

  it("marks monitor results beyond misfire as unconfirmed", async () => {
    // The bitmap is the recorded one (monitors 01 and 02); the two results are made up in the
    // layout of the recorded misfire replies.
    const replies = loadReplies(...RECORDED);
    replies.set("0601", [[0x7e8, fromHex("460107240064000000C8")]]);
    replies.set("0602", [[0x7e8, fromHex("46020784FF9CFF38006402082401F4000000C8")]]);
    replies.set("0620", [[0x7e8, fromHex("462000000000")]]);
    const car = new Car(replies);
    expect(await car.obd()).toBe(0);
    expect(car.output).toContain("meanings unconfirmed");
    expect(car.output).toContain(
      "oxygen sensor bank 1 sensor 1 from 7E8, test 07 (unit and scaling 24): value 100, limits 0 to 200, within the limits",
    );
    expect(car.output).toContain(
      "oxygen sensor bank 1 sensor 2 from 7E8, test 07 (unit and scaling 84): value -100, limits -200 to 100, within the limits",
    );
    expect(car.output).toContain(
      "sensor 2 from 7E8, test 08 (unit and scaling 24): value 500, limits 0 to 200, outside the limits",
    );
    expect(car.core.requests).toContain("0600");
  });

  it("prints no values for a car that answers nothing", async () => {
    const car = new Car(new Map());
    expect(await car.obd()).toBe(0);
    expect(car.output).toContain("no unit answered the supported current-data request");
  });
});

it("uses the compression-ignition monitor table for a diesel", () => {
  // Byte B bit 3 set: compression ignition. C0 (NMHC catalyst) and C6 (particulate filter) fitted,
  // D6 not complete.
  const readiness = decodeReadiness(fromHex("000F4140"));
  expect(readiness.compressionIgnition).toBe(true);
  expect(readiness.complete).toEqual(["misfire", "fuel system", "components", "NMHC catalyst"]);
  expect(readiness.incomplete).toEqual(["particulate filter"]);
});

it("reads the common monitors' incomplete bit from the high nibble", () => {
  const readiness = decodeReadiness(fromHex("00170000")); // all three fitted, misfire not complete
  expect(readiness.incomplete).toEqual(["misfire"]);
  expect(readiness.complete).toEqual(["fuel system", "components"]);
});

it.each([
  [0x06, "00", [-100.0]],
  [0x06, "80", [0.0]],
  [0x06, "FF", [99.21875]],
  [0x0a, "64", [300]],
  [0x10, "0190", [4.0]],
  [0x14, "5AFF", [0.45, "not used"]],
  [0x24, "80004000", [1.0, 2.0]],
  [0x34, "80008000", [1.0, 0.0]],
  [0x32, "FFFC", [-1.0]],
  [0x3c, "0000", [-40.0]],
  [0x5d, "0000", [-210.0]],
  [0x5e, "0064", [5.0]],
])("decodes parameter %i from %s by the published formula", (code, data, expected) => {
  expect(pid(code).decode(fromHex(data))).toEqual(expected);
});

it("decodes every parameter's own size of zeros", () => {
  for (const parameter of PIDS.values()) {
    expect(parameter.decode(new Uint8Array(parameter.size))).toHaveLength(parameter.columns.length);
  }
});

it("ignores other monitors' entries when decoding monitor tests", () => {
  const message = fromHex("460B012400040000FFFF0C012400050000FFFF");
  expect(decodeMonitorTests(0x0b, message).map((test) => test.value)).toEqual([4]);
});

it("formats values without exponents", () => {
  expect(formatValue(49700.0, "km")).toBe("49700 km");
  expect(formatValue("closed loop", "")).toBe("closed loop");
});

it("rounds ties to the even thousandth as Python does", () => {
  expect(formatValue(0.0625, "")).toBe("0.062");
  expect(formatValue(0.1875, "")).toBe("0.188");
  expect(formatValue(-0.0625, "")).toBe("-0.062");
  expect(formatValue(1 / 3, "ratio")).toBe("0.333 ratio");
});
