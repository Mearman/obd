/**
 * The shipped Mercedes-Benz W169 and W245 profile: it validates, holds only the engine row OBDb captured, says in its notes which parts are unverified, and reads an identification through the engine on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import { DiagProtocol, Elm, checkProfile, makeClient, simulatedCar } from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "mercedes-w169-w245";

/** The notes text of the shipped profile's raw JSON. */
function notes(): string {
  const data = builtinProfileData(NAME);
  if (
    typeof data !== "object" ||
    data === null ||
    !("notes" in data) ||
    typeof data.notes !== "string"
  ) {
    throw new Error(`${NAME} has no notes`);
  }
  return data.notes;
}

describe("the shipped mercedes-w169-w245 profile", () => {
  it("is registered and passes the profile check", () => {
    expect(builtinProfiles()).toContain(NAME);
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is unconfirmed KWP2000 on 11-bit CAN at 500 kbit/s in session 0x92", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.status).toBe("unconfirmed");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.KWP2000, 0x92]);
  });

  it("holds only the engine, on the pair OBDb captured", () => {
    const profile = loadBuiltinProfile(NAME);
    expect([...profile.units.keys()]).toEqual(["engine"]);
    const engine = profile.units.get("engine");
    expect([engine?.requestId, engine?.responseId]).toEqual([0x7e0, 0x7e8]);
    expect(engine?.source).toContain("OBDb");
    expect(engine?.source).toContain("web.archive.org/web/");
    expect(engine?.source).toContain("Not read from a car by this project.");
  });

  it("says the session and bit rate are unverified and other units have no source", () => {
    const text = notes();
    expect(text).toMatch(/so the session is unverified/);
    expect(text).toMatch(/so that is unverified too/);
    expect(text).toMatch(/no source gives W169 or W245 addresses/);
  });
});

describe("the mercedes-w169-w245 profile on the scripted adapter", () => {
  it("reads an identification through the engine", async () => {
    const profile = loadBuiltinProfile(NAME);
    const engine = profile.units.get("engine");
    if (engine === undefined) throw new Error(`${NAME} has no engine unit`);
    const elm = new Elm(fakeTransport(simulatedCar(profile)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(engine.requestId, engine.responseId, engine.extendedAddress);
    const client = makeClient(elm, profile, engine);
    await client.start();
    const fields = await client.identification();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.raw.length > 0)).toBe(true);
  });
});
