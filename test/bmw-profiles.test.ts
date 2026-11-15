/**
 * The shipped BMW profiles: each validates, addresses every unit once in BMW's extended-addressing
 * scheme, and reads end to end on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  Uds,
  UnitSession,
  checkProfile,
  decodeValue,
  fromHex,
  hexNumber,
  scan,
  simulatedCar,
  type Profile,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const BMW_PROFILES = ["bmw-f-fem", "bmw-g29", "bmw-i3"] as const;

/** The tester request identifier and reply base BMW uses, as docs/vehicles/bmw-mini.md records them. */
const BMW_REQUEST = 0x6f1;
const BMW_REPLY_BASE = 0x600;

describe("the shipped BMW profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...BMW_PROFILES]));
  });

  it.each(BMW_PROFILES)("%s passes the profile check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it.each(BMW_PROFILES)("%s addresses every unit as BMW does, each address once", (name) => {
    const profile = loadBuiltinProfile(name);
    expect(profile.status).toBe("unconfirmed");
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x01]);
    const units = [...profile.units.values()];
    for (const unit of units) {
      expect(unit.requestId).toBe(BMW_REQUEST);
      expect(unit.extendedAddress).toBeDefined();
      expect(unit.responseId).toBe(BMW_REPLY_BASE + (unit.extendedAddress ?? -1));
      expect(unit.source).toMatch(/https:\/\//);
    }
    const addresses = units.map((unit) => unit.extendedAddress);
    expect(new Set(addresses).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
  });

  it("the G29 engine decodes the source's worked example with its stated scaling", () => {
    const coolant = loadBuiltinProfile("bmw-g29")
      .units.get("dme")
      ?.values.get("coolant-temperature");
    if (coolant === undefined) throw new Error("bmw-g29 has no coolant temperature");
    expect(coolant.identifier).toBe(0x4300);
    // Reply 62 43 00 0D BA with the source's 0.1 scale and -273.14 bias gives 78.26; the source
    // prints about 80.96 for the same bytes, a contradiction docs/vehicles/bmw-mini.md records.
    expect(decodeValue(coolant, fromHex("0DBA"))).toBeCloseTo(78.26, 2);
  });
});

describe("a whole BMW profile on the scripted adapter", () => {
  it.each(BMW_PROFILES)("every unit of %s answers its own address", async (name) => {
    const profile: Profile = loadBuiltinProfile(name);
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    const reports = await scan(elm, profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered])).toEqual(
      [...profile.units.keys()].map((unit) => [unit, true]),
    );
    expect(reports.every((report) => report.faults?.length === 1)).toBe(true);
    for (const unit of profile.units.values()) {
      expect(car.sent).toContain(`ATCEA${hexNumber(unit.extendedAddress ?? -1, 2)}`);
    }
  });

  it("a session bound to one unit reads through the profile's client", async () => {
    const profile = loadBuiltinProfile("bmw-i3");
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    const bdc = profile.units.get("bdc");
    if (bdc === undefined) throw new Error("bmw-i3 has no bdc unit");
    await elm.addressUnit(bdc.requestId, bdc.responseId, bdc.extendedAddress);
    const uds = new Uds(new UnitSession(elm, profile.protocol, bdc.responseId), profile.session);
    await uds.start();
    expect(await uds.faults()).toHaveLength(1);
  });
});
