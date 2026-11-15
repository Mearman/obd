/**
 * The shipped Mercedes-Benz MFA profile: it validates, addresses every unit once, keeps the pairs the sources agree on, cites an archived source on every row, and every unit answers its own address and an identification on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  checkProfile,
  makeClient,
  scan,
  simulatedCar,
  type Profile,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "mercedes-mfa";

/** Pairs more than one source places: the engine and transmission (OBDb and the catalogue), and the OBDb-only 0x7E2 unit. */
const CORROBORATED: readonly (readonly [string, number, number])[] = [
  ["engine", 0x7e0, 0x7e8],
  ["transmission", 0x7e1, 0x7e9],
  ["obd-7e2", 0x7e2, 0x7ea],
];

/** Units whose identification exchanges the catalogue's source captured as raw frames on a W176. */
const CAPTURED: readonly (readonly [string, number, number])[] = [
  ["steering-column", 0x622, 0x484],
  ["tyre-pressure", 0x642, 0x488],
  ["parking", 0x78a, 0x4b1],
];

async function connect(profile: Profile): Promise<Elm> {
  const elm = new Elm(fakeTransport(simulatedCar(profile)));
  await elm.initialise();
  await elm.selectCan(11, 500_000);
  return elm;
}

describe("the shipped mercedes-mfa profile", () => {
  it("is registered and passes the profile check", () => {
    expect(builtinProfiles()).toContain(NAME);
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is unconfirmed UDS on 11-bit CAN at 500 kbit/s in the extended session", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.status).toBe("unconfirmed");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x03]);
  });

  it("uses every request and every response identifier once, and none as both", () => {
    const units = [...loadBuiltinProfile(NAME).units.values()];
    const requests = new Set(units.map((unit) => unit.requestId));
    expect(requests.size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
    for (const unit of units) expect(requests.has(unit.responseId)).toBe(false);
  });

  it("cites an archived source on every unit and says none was read from a car", () => {
    for (const unit of loadBuiltinProfile(NAME).units.values()) {
      expect(unit.source).toContain("web.archive.org/web/");
      expect(unit.source).toContain("Not read from a car by this project.");
      expect(unit.protocol).toBe(DiagProtocol.UDS);
    }
  });

  it.each(CORROBORATED)("holds the %s pair %i:%i that OBDb captured", (name, request, response) => {
    const unit = loadBuiltinProfile(NAME).units.get(name);
    expect([unit?.requestId, unit?.responseId]).toEqual([request, response]);
    expect(unit?.source).toContain("OBDb");
  });

  it.each(CAPTURED)(
    "holds the %s pair %i:%i the catalogue captured on a car",
    (name, request, response) => {
      const unit = loadBuiltinProfile(NAME).units.get(name);
      expect([unit?.requestId, unit?.responseId]).toEqual([request, response]);
      expect(unit?.source).toContain("on the MBito record of one W176");
    },
  );

  it("marks every unit outside the car's record as catalogue only or OBDb-sourced", () => {
    for (const unit of loadBuiltinProfile(NAME).units.values()) {
      if (unit.source.includes("not on the one car's record")) {
        expect(unit.description).toMatch(/\(catalogue only\)$/);
      }
    }
  });
});

describe("the mercedes-mfa profile on the scripted adapter", () => {
  it("hears every unit answer its own address", async () => {
    const profile = loadBuiltinProfile(NAME);
    const reports = await scan(await connect(profile), profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered])).toEqual(
      [...profile.units.keys()].map((unit) => [unit, true]),
    );
  });

  it.each(["engine", "steering-column"])("reads the VIN through the %s row", async (name) => {
    const profile = loadBuiltinProfile(NAME);
    const unit = profile.units.get(name);
    if (unit === undefined) throw new Error(`${NAME} has no ${name} unit`);
    const elm = await connect(profile);
    await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
    const client = makeClient(elm, profile, unit);
    await client.start();
    const fields = await client.identification();
    expect(fields.find((field) => field.label === "VIN")?.text).toBe("SIMULATEDCAR00001");
  });
});
