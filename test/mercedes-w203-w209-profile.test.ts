/**
 * The shipped mercedes-w203-w209 profile: it validates, gives each unit its own request and response identifier, shares the mercedes-w211 profile's addressing wherever the two list the same unit, and scans end to end on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import { DiagProtocol, Elm, checkProfile, scan, simulatedCar } from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "mercedes-w203-w209";

describe("the mercedes-w203-w209 profile", () => {
  it("is registered and passes the profile check", () => {
    expect(builtinProfiles()).toContain(NAME);
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is an unconfirmed KWP2000 profile on 11-bit 500 kbit/s CAN", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.status).toBe("unconfirmed");
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.KWP2000, 0x92]);
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
  });

  it("gives every unit its own identifiers and a traceable source", () => {
    const units = [...loadBuiltinProfile(NAME).units.values()];
    for (const unit of units) {
      expect(unit.extendedAddress).toBeUndefined();
      expect(unit.source).toMatch(/https:\/\/github\.com\/rnd-ash\/W203-canbus\//);
    }
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
  });

  it("answers each request the mercedes-w211 profile also lists on the same response", () => {
    const w211 = new Map(
      [...loadBuiltinProfile("mercedes-w211").units.values()].map((unit) => [
        unit.requestId,
        unit.responseId,
      ]),
    );
    const shared = [...loadBuiltinProfile(NAME).units.values()].filter((unit) =>
      w211.has(unit.requestId),
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const unit of shared) {
      expect(unit.responseId).toBe(w211.get(unit.requestId));
    }
  });
});

describe("the mercedes-w203-w209 profile on the scripted adapter", () => {
  it("scans every unit and reads its fault codes", async () => {
    const profile = loadBuiltinProfile(NAME);
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    const reports = await scan(elm, profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered])).toEqual(
      [...profile.units.keys()].map((unit) => [unit, true]),
    );
    expect(reports.every((report) => report.faults?.length === 1)).toBe(true);
  });
});
