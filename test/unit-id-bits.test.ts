/**
 * A unit's own CAN identifier width: the profile field, the check against it, and the adapter switching
 * protocol between 11-bit and 29-bit units at the bit rate already selected. The bytes are invented.
 */

import { describe, expect, it } from "vitest";
import { Elm, checkProfile, parseProfile, simulatedCar } from "../src/core/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";
import { MINIMAL, edit } from "./support/profiles.js";

/** A profile of one 11-bit unit and one 29-bit unit. */
const MIXED = parseProfile(
  edit(MINIMAL, ["units"], {
    narrow: {
      description: "Narrow",
      request: 0x752,
      response: 0x772,
      source: "made up for the test",
    },
    wide: {
      description: "Wide",
      request: 0x18dadaf1,
      response: 0x18daf1da,
      id_bits: 29,
      source: "made up for the test",
    },
  }),
  "mixed",
);

describe("a unit's identifier width", () => {
  const base = edit(MINIMAL, ["units", "engine", "id_bits"], 29);

  it("defaults to the bus width and is read from the unit when given", () => {
    expect(parseProfile(MINIMAL, "x").units.get("engine")?.idBits).toBe(11);
    const wide = parseProfile(
      edit(
        edit(base, ["units", "engine", "request"], 0x18da10f1),
        ["units", "engine", "response"],
        0x18daf110,
      ),
      "x",
    );
    expect(wide.units.get("engine")?.idBits).toBe(29);
  });

  it("is checked against its own width, not the bus's", () => {
    expect(checkProfile(base, "x")).toEqual([]);
    const narrow = edit(MINIMAL, ["units", "engine", "id_bits"], 11);
    const tooWide = edit(narrow, ["units", "engine", "request"], 0x18da10f1);
    expect(checkProfile(tooWide, "x")).toEqual([
      "[units.engine]: request 0x18da10f1 does not fit 11-bit identifiers",
    ]);
  });

  it("is refused when it is neither 11 nor 29", () => {
    expect(checkProfile(edit(MINIMAL, ["units", "engine", "id_bits"], 12), "x")).toEqual([
      "x [units.engine]: id_bits must be 11 or 29, got 12",
    ]);
  });

  it("is refused on a K-line bus", () => {
    const kline = edit(edit(MINIMAL, ["bus"], { kline: "kwp2000-fast" }), ["diagnostics"], {
      protocol: "kwp2000",
      session: 0x81,
    });
    const problems = checkProfile(edit(kline, ["units", "engine", "id_bits"], 29), "x");
    expect(problems).toEqual([
      "x [units.engine]: id_bits is a CAN identifier width and a K-line bus has none",
    ]);
  });
});

describe("Elm.addressUnit with a width", () => {
  it("refuses to change width before a bus is selected", async () => {
    const elm = new Elm(fakeTransport(simulatedCar(MIXED)));
    await expect(elm.addressUnit(0x18dadaf1, 0x18daf1da, undefined, 29)).rejects.toThrow(
      /select the CAN bus/,
    );
  });

  it("leaves the protocol alone when the width already matches", async () => {
    const car = simulatedCar(MIXED);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    car.sent.length = 0;
    await elm.addressUnit(0x752, 0x772, undefined, 11);
    expect(car.sent.filter((line) => line.startsWith("ATSP"))).toEqual([]);
  });
});
