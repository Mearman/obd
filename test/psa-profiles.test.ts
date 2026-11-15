/**
 * The shipped PSA profiles: each validates, every request and response identifier is used once,
 * the two protocol profiles agree on every identifier they share, and a unit of each reads its
 * identification through the scripted adapter.
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

const PSA_PROFILES = ["psa-kwp2000", "psa-uds"] as const;

/** Pairs the arduino-psa-diag table gives, each also in a PyPSADiag ECU file that states the protocol. */
const CORROBORATED_UDS: readonly (readonly [number, number])[] = [
  [0x752, 0x652],
  [0x6a8, 0x688],
  [0x6a9, 0x689],
  [0x6ad, 0x68d],
  [0x75f, 0x65f],
];

function idPairs(profile: Profile): Map<string, string> {
  return new Map(
    [...profile.units.values()].map((unit) => [
      unit.name,
      `${unit.requestId.toString(16)}:${unit.responseId.toString(16)}`,
    ]),
  );
}

describe("the shipped PSA profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...PSA_PROFILES]));
  });

  it.each(PSA_PROFILES)("%s passes the profile check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it.each(PSA_PROFILES)("%s is unconfirmed throughout and uses the diagnostic CAN", (name) => {
    const profile = loadBuiltinProfile(name);
    expect(profile.status).toBe("unconfirmed");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    for (const unit of profile.units.values()) {
      expect(unit.source).toMatch(/https:\/\//);
      expect(unit.description).toMatch(/^(Table families on |PyPSADiag)/);
    }
  });

  it.each(PSA_PROFILES)("%s uses every request and every response identifier once", (name) => {
    const units = [...loadBuiltinProfile(name).units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
    for (const unit of units) expect(unit.requestId).not.toBe(unit.responseId);
  });

  it("names the protocol and session each profile opens", () => {
    const kwp = loadBuiltinProfile("psa-kwp2000");
    const uds = loadBuiltinProfile("psa-uds");
    expect([kwp.protocol, kwp.session]).toEqual([DiagProtocol.KWP2000, 0x81]);
    expect([uds.protocol, uds.session]).toEqual([DiagProtocol.UDS, 0x01]);
  });

  it("gives a unit the same identifiers in both profiles", () => {
    const kwp = idPairs(loadBuiltinProfile("psa-kwp2000"));
    const uds = idPairs(loadBuiltinProfile("psa-uds"));
    for (const [name, pair] of kwp) {
      if (uds.has(name)) expect(uds.get(name)).toBe(pair);
    }
  });

  it("records a response that is not the request minus 0x100", () => {
    const offsets = new Set(
      [...loadBuiltinProfile("psa-uds").units.values()].map(
        (unit) => unit.requestId - unit.responseId,
      ),
    );
    expect(offsets.has(0x100)).toBe(true);
    expect(offsets.size).toBeGreaterThan(1);
  });

  it.each(CORROBORATED_UDS)("psa-uds holds the table pair %i:%i", (request, response) => {
    const unit = [...loadBuiltinProfile("psa-uds").units.values()].find(
      (candidate) => candidate.requestId === request,
    );
    expect(unit?.responseId).toBe(response);
    expect(unit?.source).toMatch(/PyPSADiag/);
  });

  it("leaves out the pairs only PyPSADiag lists as the 125 kbit/s KWP2000 variant", () => {
    for (const name of PSA_PROFILES) {
      const requests = new Set(
        [...loadBuiltinProfile(name).units.values()].map((unit) => unit.requestId),
      );
      for (const hab of [0x744, 0x760, 0x77d, 0x6c4]) expect(requests.has(hab)).toBe(false);
    }
  });
});

describe("a PSA profile on the scripted adapter", () => {
  it.each(PSA_PROFILES)("every unit of %s answers its own address", async (name) => {
    const profile = loadBuiltinProfile(name);
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    const reports = await scan(elm, profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered])).toEqual(
      [...profile.units.keys()].map((unit) => [unit, true]),
    );
  });

  it.each([
    ["psa-uds", "bmf-752", 0x752, 0x652, "VIN"],
    ["psa-kwp2000", "directn-6b5", 0x6b5, 0x695, "identification"],
  ])(
    "%s reads an identification through the %s row",
    async (name, unitName, request, response, label) => {
      const profile = loadBuiltinProfile(name);
      const unit = profile.units.get(unitName);
      if (unit === undefined) throw new Error(`${name} has no ${unitName} unit`);
      expect([unit.requestId, unit.responseId]).toEqual([request, response]);
      const elm = new Elm(fakeTransport(simulatedCar(profile)));
      await elm.initialise();
      await elm.selectCan(11, 500_000);
      await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
      const client = makeClient(elm, profile, unit);
      await client.start();
      const fields = await client.identification();
      expect(fields.map((field) => field.label)).toContain(label);
      expect(fields.every((field) => field.raw.length > 0)).toBe(true);
    },
  );
});
