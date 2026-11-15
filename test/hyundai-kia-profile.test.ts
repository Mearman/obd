/**
 * The shipped Hyundai, Kia and Genesis profile: it validates, addresses each unit once, follows the
 * request-plus-8 reply rule its sources state, and reads an identification through its rows on the
 * scripted adapter.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  checkProfile,
  readUnit,
  simulatedCar,
  type Profile,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "hyundai-kia-genesis";

/** The units that read with service 21 and a one-byte local identifier, from the profile's sources. */
const SERVICE_21_UNITS = ["engine", "transmission", "vmcu", "obc", "tpms"];

/** The offset between a request identifier and its reply that every source uses. */
const REPLY_OFFSET = 8;

function profile(): Profile {
  return loadBuiltinProfile(NAME);
}

describe("the shipped Hyundai, Kia and Genesis profile", () => {
  it("is registered", () => {
    expect(builtinProfiles()).toContain(NAME);
  });

  it("passes the profile check", () => {
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is unconfirmed, with a source on every row", () => {
    const loaded = profile();
    expect(loaded.status).toBe("unconfirmed");
    for (const unit of loaded.units.values()) {
      expect(unit.source).toMatch(/https:\/\//);
      for (const value of unit.values.values()) expect(value.status).toBe("unconfirmed");
    }
  });

  it("gives every unit its own request and reply identifier, the reply being the request plus 8", () => {
    const units = [...profile().units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
    for (const unit of units) {
      expect(unit.extendedAddress).toBeUndefined();
      expect(unit.responseId).toBe(unit.requestId + REPLY_OFFSET);
    }
  });

  it("reads the units its sources read with service 21 by local identifier, the rest with service 22", () => {
    for (const [name, unit] of profile().units) {
      const expected = SERVICE_21_UNITS.includes(name) ? DiagProtocol.KWP2000 : DiagProtocol.UDS;
      expect([name, unit.protocol]).toEqual([name, expected]);
    }
  });
});

describe("the Hyundai, Kia and Genesis profile on the scripted adapter", () => {
  it("reads an identification through the row of each unit in that unit's own protocol", async () => {
    const loaded = profile();
    const car = simulatedCar(loaded);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    for (const [name, unit] of loaded.units) {
      const report = await readUnit(elm, loaded, unit, { faults: false, freeze: false });
      expect([name, report.answered, report.identification.size > 0]).toEqual([name, true, true]);
      expect(report.requestId).toBe(unit.requestId.toString(16).toUpperCase());
    }
    expect(car.sent).toContain("1001");
    expect(car.sent).toContain("1081");
  });
});
