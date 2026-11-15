/**
 * The shipped VW up! profile: it validates, addresses every unit once, keeps the sourced
 * identifier pairs and reads an identification value through a row on the scripted adapter.
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

/** The request identifiers the VAG diagnostic block shares; the pairs inside it reply at plus 0x08. */
const ENGINE_BLOCK = (request: number): boolean => request >= 0x7e0 && request <= 0x7e7;

/** Where GoingElectric and OVMS disagree on the response identifier: the OVMS value, by unit. */
const OVMS_RESPONSE = new Map([
  ["brake-booster", 0x743],
  ["steering-assist", 0x71a],
  ["brake-sensors", 0x76a],
]);

describe("the shipped vw-up profile", () => {
  it("is registered and passes the profile check", () => {
    expect(builtinProfiles()).toContain("vw-up");
    expect(checkProfile(builtinProfileData("vw-up"), "vw-up")).toEqual([]);
  });

  it("is unconfirmed UDS on 11-bit CAN at 500 kbit/s in the default session", () => {
    const profile = loadBuiltinProfile("vw-up");
    expect(profile.status).toBe("unconfirmed");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x01]);
  });

  it("addresses every unit once and names its VAG address and sources", () => {
    const units = [...loadBuiltinProfile("vw-up").units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
    const requests = new Set(units.map((unit) => unit.requestId));
    for (const unit of units) {
      expect(unit.description).toMatch(/^VAG address [0-9A-F]{2}: /);
      expect(unit.source).toContain("web.archive.org/web/");
      expect(requests.has(unit.responseId)).toBe(false);
    }
  });

  it("replies at plus 0x08 inside the 0x7E0 block and plus 0x6A elsewhere", () => {
    for (const unit of loadBuiltinProfile("vw-up").units.values()) {
      expect(unit.responseId - unit.requestId).toBe(ENGINE_BLOCK(unit.requestId) ? 0x08 : 0x6a);
    }
  });

  it("ships the GoingElectric response for each conflict and records the OVMS one", () => {
    const profile = loadBuiltinProfile("vw-up");
    for (const [name, ovms] of OVMS_RESPONSE) {
      const unit = profile.units.get(name);
      if (unit === undefined) throw new Error(`vw-up has no ${name} unit`);
      expect(unit.responseId).not.toBe(ovms);
      expect(unit.description).toContain(`0x${ovms.toString(16)}`);
      expect(unit.source).toContain("CONFLICT");
    }
  });

  it("pairs the addresses the MQB profile shares with the same identifiers", () => {
    const up = loadBuiltinProfile("vw-up");
    const mqb = loadBuiltinProfile("vag-mqb");
    const pairs: readonly (readonly [string, string])[] = [
      ["motor-electronics", "engine"],
      ["brake-electronics", "abs"],
      ["instrument-cluster", "dashboard"],
      ["airbag", "srs"],
    ];
    for (const [upName, mqbName] of pairs) {
      const a = up.units.get(upName);
      const b = mqb.units.get(mqbName);
      expect([a?.requestId, a?.responseId]).toEqual([b?.requestId, b?.responseId]);
    }
  });
});

describe("the vw-up profile on the scripted adapter", () => {
  it.each(["charger", "brake-booster"])("reads the VIN through the %s row", async (name) => {
    const profile: Profile = loadBuiltinProfile("vw-up");
    const unit = profile.units.get(name);
    if (unit === undefined) throw new Error(`vw-up has no ${name} unit`);
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(unit.requestId, unit.responseId);
    const uds = new Uds(new UnitSession(elm, profile.protocol, unit.responseId), profile.session);
    await uds.start();
    const fields = await uds.identification();
    expect(fields.find((field) => field.label === "VIN")?.text).toBe("SIMULATEDCAR00001");
  });
});
