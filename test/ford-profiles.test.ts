/**
 * The shipped Ford profiles: each validates, gives every unit its own request identifier with the
 * response at the request plus 8 (ISO 15765-4), and reads an identification value through a Ford
 * row on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  Uds,
  UnitSession,
  checkProfile,
  simulatedCar,
  type Profile,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const FORD_PROFILES = ["ford-focus", "ford-ranger"] as const;

/** The ISO 15765-4 distance from a request identifier to its response identifier. */
const RESPONSE_OFFSET = 8;

describe("the shipped Ford profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...FORD_PROFILES]));
  });

  it.each(FORD_PROFILES)("%s passes the profile check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it.each(FORD_PROFILES)("%s is an unconfirmed UDS profile on 11-bit 500 kbit/s CAN", (name) => {
    const profile = loadBuiltinProfile(name);
    expect(profile.status).toBe("unconfirmed");
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x01]);
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
  });

  it.each(FORD_PROFILES)("%s answers each request at the request plus 8, each id once", (name) => {
    const units = [...loadBuiltinProfile(name).units.values()];
    for (const unit of units) {
      expect(unit.responseId).toBe(unit.requestId + RESPONSE_OFFSET);
      expect(unit.extendedAddress).toBeUndefined();
      expect(unit.source).toMatch(/https:\/\//);
    }
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
  });

  it("gives the engine and ABS rows the identifiers the sources name", () => {
    for (const name of FORD_PROFILES) {
      const profile = loadBuiltinProfile(name);
      expect(profile.units.get("pcm")?.requestId).toBe(0x7e0);
      expect(profile.units.get("abs")?.requestId).toBe(0x760);
    }
  });

  it.each([
    ["ford-focus", [0x726, 0x727, 0x733, 0x7a6, 0x7a7]],
    ["ford-ranger", [0x751, 0x791, 0x7a7, 0x7c4, 0x7c6]],
  ] as const)("%s leaves out the units the manual puts on MS-CAN", (name, msCan) => {
    const ids = [...loadBuiltinProfile(name).units.values()].map((unit) => unit.requestId);
    expect(ids.filter((id) => msCan.some((excluded) => excluded === id))).toEqual([]);
  });
});

describe("a Ford profile on the scripted adapter", () => {
  it.each(FORD_PROFILES)("reads an identification value through a %s row", async (name) => {
    const profile: Profile = loadBuiltinProfile(name);
    const unit = profile.units.get("abs");
    if (unit === undefined) throw new Error(`${name} has no abs unit`);
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
    const uds = new Uds(new UnitSession(elm, profile.protocol, unit.responseId), profile.session);
    await uds.start();
    const fields = await uds.identification();
    expect(fields.length).toBeGreaterThan(0);
  });
});
