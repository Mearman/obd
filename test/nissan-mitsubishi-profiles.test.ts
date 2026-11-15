/**
 * The shipped Nissan, Infiniti and Mitsubishi profiles: each validates, addresses each unit once,
 * keeps the response offsets and services its sources give, and reads end to end on the scripted
 * adapter with both KWP2000 service 21 and UDS service 22 rows.
 */

import { describe, expect, it } from "vitest";
import {
  Elm,
  Kwp2000,
  SIMULATED_KWP_RECORD,
  SIMULATED_UDS_RECORD,
  Uds,
  checkProfile,
  makeClient,
  scan,
  simulatedCar,
  unitSession,
  type Profile,
  type Unit,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const PROFILES = [
  "nissan-leaf",
  "nissan-infiniti-can",
  "nissan-infiniti-can-29bit",
  "mitsubishi-phev-imiev",
] as const;

function unitOf(profile: Profile, name: string): Unit {
  const unit = profile.units.get(name);
  if (unit === undefined) throw new Error(`${profile.name} has no unit ${name}`);
  return unit;
}

function pairs(profile: Profile): Record<string, readonly [number, number]> {
  return Object.fromEntries(
    [...profile.units].map(([name, unit]) => [name, [unit.requestId, unit.responseId]]),
  );
}

describe("the shipped Nissan and Mitsubishi profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...PROFILES]));
  });

  it.each(PROFILES)("%s passes the profile check and is unconfirmed throughout", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
    const profile = loadBuiltinProfile(name);
    expect(profile.status).toBe("unconfirmed");
    for (const unit of profile.units.values()) expect(unit.source).toMatch(/https:\/\//);
    for (const value of [...profile.units.values()].flatMap((unit) => [...unit.values.values()])) {
      expect(value.status).toBe("unconfirmed");
    }
  });

  it.each(PROFILES)("%s addresses every request and response identifier once", (name) => {
    const units = [...loadBuiltinProfile(name).units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
  });

  it.each(PROFILES)("%s warns about the 2020 secure gateway", (name) => {
    expect(Reflect.get(Object(builtinProfileData(name)), "notes")).toMatch(
      /secure gateway from 2020/,
    );
  });

  it("the Leaf reads its battery controller with service 21 and its charger with service 22", () => {
    const leaf = loadBuiltinProfile("nissan-leaf");
    expect(leaf.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect(pairs(leaf)).toMatchObject({ battery: [0x79b, 0x7bb], charger: [0x797, 0x79a] });
    expect([unitOf(leaf, "battery").protocol, unitOf(leaf, "battery").session]).toEqual([
      "kwp2000",
      0x81,
    ]);
    expect([unitOf(leaf, "charger").protocol, unitOf(leaf, "charger").session]).toEqual([
      "uds",
      0x01,
    ]);
  });

  it("the Nissan CAN profile keeps response offsets other than 8", () => {
    const profile = loadBuiltinProfile("nissan-infiniti-can");
    expect(pairs(profile)).toMatchObject({
      abs: [0x740, 0x760],
      meter: [0x743, 0x763],
      engine: [0x7e0, 0x7e8],
      "unit-723": [0x723, 0x735],
    });
    const offsets = new Set([...profile.units.values()].map((u) => u.responseId - u.requestId));
    expect(offsets).toEqual(new Set([0x8, 0x12, 0x20]));
  });

  it("the 29-bit Nissan profile addresses units by ISO 15765-4 fixed addressing", () => {
    const profile = loadBuiltinProfile("nissan-infiniti-can-29bit");
    expect(profile.bus).toEqual({ kind: "can", idBits: 29, bitrate: 500_000 });
    expect(pairs(profile)).toMatchObject({
      gateway: [0x18dad0f1, 0x18daf1d0],
      "unit-15": [0x18da15f1, 0x18daf115],
    });
  });

  it("the Mitsubishi profile has the battery and charger the i-MiEV and Outlander share", () => {
    const profile = loadBuiltinProfile("mitsubishi-phev-imiev");
    expect(pairs(profile)).toMatchObject({
      battery: [0x761, 0x762],
      charger: [0x765, 0x766],
      "unit-600": [0x600, 0x500],
    });
    expect(unitOf(profile, "battery").protocol).toBe("kwp2000");
    expect(unitOf(profile, "unit-743").protocol).toBe("uds");
  });
});

describe("a whole Nissan or Mitsubishi profile on the scripted adapter", () => {
  it.each(PROFILES)("every unit of %s answers its own identifier pair", async (name) => {
    const profile = loadBuiltinProfile(name);
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(profile.bus.kind === "can" ? profile.bus.idBits : 11, 500_000);
    const reports = await scan(elm, profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered])).toEqual(
      [...profile.units.keys()].map((unit) => [unit, true]),
    );
    for (const report of reports) {
      expect(report.identification.size, report.unit).toBeGreaterThan(0);
    }
  });

  it("reads a record through service 21 on a KWP2000 unit and service 22 on a UDS unit", async () => {
    const profile = loadBuiltinProfile("nissan-leaf");
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(11, 500_000);

    const battery = unitOf(profile, "battery");
    await elm.addressUnit(battery.requestId, battery.responseId);
    const kwp = makeClient(elm, profile, battery);
    if (!(kwp instanceof Kwp2000)) throw new Error("the battery controller is not a KWP2000 unit");
    await kwp.start();
    const [localIdentifier, localValue] = SIMULATED_KWP_RECORD;
    expect(await kwp.readValue(localIdentifier)).toEqual(localValue);

    const charger = unitOf(profile, "charger");
    await elm.addressUnit(charger.requestId, charger.responseId);
    const uds = makeClient(elm, profile, charger);
    if (!(uds instanceof Uds)) throw new Error("the charger is not a UDS unit");
    await uds.start();
    const [identifier, value] = SIMULATED_UDS_RECORD;
    expect(await uds.readValue(identifier)).toEqual(value);

    const services = car.requests.map((line) => line.slice(0, 2));
    expect(services).toContain("21");
    expect(services).toContain("22");
    expect(unitSession(elm, profile, battery).protocol).toBe("kwp2000");
    expect(unitSession(elm, profile, charger).protocol).toBe("uds");
  });
});
