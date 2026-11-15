/**
 * The shipped Mazda SkyActiv and Honda and Acura profiles: each validates, carries the addressing
 * scheme its make uses with every pair listed once, and reads an identification value through a
 * row on the scripted adapter, over 11-bit CAN for Mazda and 29-bit CAN for Honda.
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

const PROFILES = ["mazda-skyactiv", "honda-acura-29bit"] as const;

/** The ISO 15765-4 29-bit physical request for a unit: priority 0x18, format 0xDA, target, then the tester 0xF1. */
function honda29(unit: number): { request: number; response: number } {
  return {
    request: 0x18da0000 + unit * 0x100 + 0xf1,
    response: 0x18da0000 + 0xf100 + unit,
  };
}

describe("the shipped Mazda and Honda profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...PROFILES]));
  });

  it.each(PROFILES)("%s passes the profile check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it.each(PROFILES)(
    "%s is unconfirmed, read-only UDS, and every row cites archived sources",
    (name) => {
      const profile = loadBuiltinProfile(name);
      expect(profile.status).toBe("unconfirmed");
      expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x01]);
      for (const unit of profile.units.values()) {
        expect(unit.extendedAddress).toBeUndefined();
        expect(unit.source).toMatch(/https:\/\/web\.archive\.org\/web\/\d{14}\//);
        expect(unit.values.size).toBe(0);
      }
    },
  );

  it.each(PROFILES)("%s lists every request and every response once", (name) => {
    const units = [...loadBuiltinProfile(name).units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
  });

  it("Mazda pairs are 11-bit identifiers, the reply 8 above the request", () => {
    const profile = loadBuiltinProfile("mazda-skyactiv");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    for (const unit of profile.units.values()) {
      expect(unit.requestId).toBeLessThanOrEqual(0x7ff);
      expect(unit.responseId - unit.requestId).toBe(unit.requestId === 0x7d0 ? 0xa : 8);
    }
    const engine = profile.units.get("engine");
    expect([engine?.requestId, engine?.responseId]).toEqual([0x7e0, 0x7e8]);
  });

  it("Honda pairs are 29-bit 18DAxxF1 requests answered from 18DAF1xx", () => {
    const profile = loadBuiltinProfile("honda-acura-29bit");
    expect(profile.bus).toEqual({ kind: "can", idBits: 29, bitrate: 500_000 });
    for (const unit of profile.units.values()) {
      const target = (unit.requestId >> 8) & 0xff;
      expect(unit.requestId).toBe(honda29(target).request);
      expect(unit.responseId).toBe(honda29(target).response);
    }
    const engine = profile.units.get("engine");
    expect([engine?.requestId, engine?.responseId]).toEqual([0x18da10f1, 0x18daf110]);
    expect(profile.units.get("srs")?.requestId).toBe(0x18da53f1);
  });
});

describe("a profile read on the scripted adapter", () => {
  async function connect(profile: Profile): Promise<Elm> {
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(profile.bus.kind === "can" ? profile.bus.idBits : 11, 500_000);
    return elm;
  }

  async function readIdent(profileName: string, unitName: string) {
    const profile = loadBuiltinProfile(profileName);
    const unit = profile.units.get(unitName);
    if (unit === undefined) throw new Error(`${profileName} has no ${unitName}`);
    const elm = await connect(profile);
    await elm.addressUnit(unit.requestId, unit.responseId);
    const uds = new Uds(new UnitSession(elm, profile.protocol, unit.responseId), profile.session);
    await uds.start();
    return (await uds.identification()).map((field) => field.label);
  }

  it("reads an identification value through a Mazda 11-bit row", async () => {
    expect(await readIdent("mazda-skyactiv", "abs")).toContain("VIN");
  });

  it("reads an identification value through a Honda 29-bit row", async () => {
    expect(await readIdent("honda-acura-29bit", "srs")).toContain("VIN");
  });

  it("sends the Honda header as priority and low bytes, and answers only from its own row", async () => {
    const profile = loadBuiltinProfile("honda-acura-29bit");
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(29, 500_000);
    await elm.addressUnit(0x18da53f1, 0x18daf153);
    expect(car.sent).toEqual(
      expect.arrayContaining(["ATSP7", "ATCP18", "ATSHDA53F1", "ATCRA18DAF153"]),
    );
    expect(car.header).toBe(0x18da53f1);
  });

  it("a unit whose request was changed no longer answers", async () => {
    const profile = loadBuiltinProfile("honda-acura-29bit");
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(29, 500_000);
    // 18DA54F1 is not a row of the profile, so the car has no unit there.
    await elm.addressUnit(0x18da54f1, 0x18daf154);
    const uds = new Uds(new UnitSession(elm, profile.protocol, 0x18daf154), profile.session);
    await expect(uds.start()).rejects.toThrow();
  });

  it.each(PROFILES)(
    "every unit of %s answers its own address on the scripted car",
    async (name) => {
      const profile = loadBuiltinProfile(name);
      const elm = await connect(profile);
      for (const unit of profile.units.values()) {
        await elm.addressUnit(unit.requestId, unit.responseId);
        const uds = new Uds(
          new UnitSession(elm, profile.protocol, unit.responseId),
          profile.session,
        );
        await uds.start();
        expect(await uds.faults()).toHaveLength(1);
      }
    },
  );
});
