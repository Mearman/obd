/**
 * The shipped Renault Alliance profiles: each validates, addresses every unit once, names the sources it
 * was built from, and reads an identification end to end on the scripted adapter, including the units
 * that sit on 29-bit identifiers inside an otherwise 11-bit profile.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  SIMULATED_VIN,
  UnitSession,
  checkProfile,
  concatBytes,
  fromHex,
  simulatedCar,
  type Profile,
  type Unit,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const RENAULT_PROFILES = [
  "renault-dacia-core",
  "renault-twingo-smart-453",
  "renault-twizy",
  "renault-zoe-ph1",
  "renault-zoe-ph2",
] as const;

/** Profiles that carry units on 29-bit identifiers inside an 11-bit profile. */
const MIXED_WIDTH = ["renault-twingo-smart-453", "renault-zoe-ph2"] as const;

const MAX_11_BIT = 0x7ff;

/** The notes text of a shipped profile's raw JSON. */
function notesOf(name: string): string {
  const data = builtinProfileData(name);
  if (
    typeof data !== "object" ||
    data === null ||
    !("notes" in data) ||
    typeof data.notes !== "string"
  ) {
    throw new Error(`${name} has no notes`);
  }
  return data.notes;
}

function unitNamed(profile: Profile, name: string): Unit {
  const unit = profile.units.get(name);
  if (unit === undefined) throw new Error(`${profile.name} has no unit ${name}`);
  return unit;
}

/** A scripted car for `profile`, an adapter on it with the bus selected, and the request lines it sees. */
async function connect(profile: Profile) {
  const car = simulatedCar(profile);
  const elm = new Elm(fakeTransport(car));
  await elm.initialise();
  await elm.selectCan(11, 500_000);
  return { car, elm };
}

async function readIdent(elm: Elm, profile: Profile, unit: Unit): Promise<Uint8Array> {
  await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress, unit.idBits);
  return new UnitSession(elm, profile.protocol, unit.responseId).request(fromHex("22F190"));
}

describe("the shipped Renault profiles", () => {
  it("are registered", () => {
    expect(builtinProfiles()).toEqual(expect.arrayContaining([...RENAULT_PROFILES]));
  });

  it.each(RENAULT_PROFILES)("%s passes the profile check", (name) => {
    expect(checkProfile(builtinProfileData(name), name)).toEqual([]);
  });

  it.each(RENAULT_PROFILES)("%s is unconfirmed, read-only and sourced on every unit", (name) => {
    const profile = loadBuiltinProfile(name);
    expect(profile.status).toBe("unconfirmed");
    expect(profile.protocol).toBe(DiagProtocol.UDS);
    expect([0x01, 0x03]).toContain(profile.session);
    for (const unit of profile.units.values()) {
      expect(unit.source).toContain("CanZE");
      expect(unit.source).toContain("ddt4all");
      expect(unit.source).toMatch(/https:\/\/web\.archive\.org\/web\/\d{14}\//);
    }
  });

  it.each(RENAULT_PROFILES)("%s uses each request and response pair once", (name) => {
    const units = [...loadBuiltinProfile(name).units.values()];
    const requests = units.map((unit) => unit.requestId);
    const responses = units.map((unit) => unit.responseId);
    expect(new Set(requests).size).toBe(units.length);
    expect(new Set(responses).size).toBe(units.length);
    // A reply identifier that is also some unit's request would be read as that unit's traffic.
    expect(requests.filter((id) => responses.includes(id))).toEqual([]);
  });

  it.each(RENAULT_PROFILES)(
    "%s gives each unit the identifier width its identifiers need",
    (name) => {
      for (const unit of loadBuiltinProfile(name).units.values()) {
        const wide = unit.requestId > MAX_11_BIT || unit.responseId > MAX_11_BIT;
        expect(unit.idBits).toBe(wide ? 29 : 11);
      }
    },
  );

  it.each(RENAULT_PROFILES)(
    "%s says in its notes that a silent unit is not an absent one",
    (name) => {
      const notes = notesOf(name);
      expect(notes).toMatch(/security gateway/i);
      expect(notes).toMatch(/no response, not as absent/);
    },
  );

  it("the core profile names its model-year scope as an inference", () => {
    const notes = notesOf("renault-dacia-core");
    expect(notes).toMatch(/2018 model year/);
    expect(notes).toMatch(/inference, not a sourced date/);
  });

  it("the core profile names the Citan W415 and says its unit fit is unsourced", () => {
    expect(loadBuiltinProfile("renault-dacia-core").description).toContain("Citan W415");
    const notes = notesOf("renault-dacia-core");
    expect(notes).toMatch(/"Daimler Citan" project \(code VS10/);
    expect(notes).toMatch(/no source says which of these units a Citan fits/);
  });

  it("keeps the addresses the CanZE files and the ddt4all table agree on", () => {
    const pairs: readonly [string, string, number, number][] = [
      ["renault-zoe-ph1", "evc", 0x7e4, 0x7ec],
      ["renault-zoe-ph1", "lbc", 0x79b, 0x7bb],
      ["renault-zoe-ph1", "cluster", 0x743, 0x763],
      ["renault-twizy", "bcb-obc", 0x792, 0x793],
      ["renault-dacia-core", "engine", 0x7e0, 0x7e8],
      ["renault-twingo-smart-453", "gearbox", 0x7e1, 0x7e9],
      ["renault-twingo-smart-453", "s-gw3", 0x18dad2f1, 0x18daf1d2],
      ["renault-zoe-ph2", "evc", 0x18dadaf1, 0x18daf1da],
      ["renault-zoe-ph2", "airbag", 0x752, 0x772],
    ];
    for (const [profile, unit, request, response] of pairs) {
      const found = unitNamed(loadBuiltinProfile(profile), unit);
      expect([found.requestId, found.responseId]).toEqual([request, response]);
    }
  });

  it.each(MIXED_WIDTH)("%s has both widths, each unit carrying its own", (name) => {
    const widths = new Set([...loadBuiltinProfile(name).units.values()].map((unit) => unit.idBits));
    expect(widths).toEqual(new Set([11, 29]));
  });

  it("the Zoe phase 1 profile opens the default session, not the 0xC0 CanZE lists", () => {
    expect(loadBuiltinProfile("renault-zoe-ph1").session).toBe(0x01);
  });
});

describe("a Renault profile on the scripted adapter", () => {
  it.each(RENAULT_PROFILES)("%s reads an identification through every unit", async (name) => {
    const profile = loadBuiltinProfile(name);
    const { elm } = await connect(profile);
    for (const unit of profile.units.values()) {
      expect(await readIdent(elm, profile, unit), unit.name).toEqual(
        concatBytes(fromHex("62F190"), SIMULATED_VIN),
      );
    }
  });

  it("moves between 11-bit and 29-bit units, reselecting the protocol only when the width changes", async () => {
    const profile = loadBuiltinProfile("renault-zoe-ph2");
    const { car, elm } = await connect(profile);
    car.sent.length = 0;
    await readIdent(elm, profile, unitNamed(profile, "airbag"));
    await readIdent(elm, profile, unitNamed(profile, "bcm"));
    await readIdent(elm, profile, unitNamed(profile, "evc"));
    await readIdent(elm, profile, unitNamed(profile, "lbc"));
    await readIdent(elm, profile, unitNamed(profile, "hvac"));
    expect(car.sent.filter((line) => line.startsWith("ATSP"))).toEqual(["ATSP7", "ATSP6"]);
    expect(car.sent).toContain("ATCP18");
    expect(car.sent).toContain("ATSHDADAF1");
    expect(car.sent).toContain("ATCRA18DAF1DA");
  });

  it("keeps the bit rate when it switches width", async () => {
    const profile = loadBuiltinProfile("renault-twingo-smart-453");
    const { car, elm } = await connect(profile);
    await readIdent(elm, profile, unitNamed(profile, "s-gw3"));
    expect(car.baud).toBe(500_000);
    expect(car.idChars).toBe(8);
  });
});
