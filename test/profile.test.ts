import { describe, expect, it } from "vitest";
import {
  PROFILE_PROTOCOLS,
  ProfileError,
  READ_ONLY,
  isReadOnlySession,
  canBus,
  decodeValue,
  parseProfile,
  parseProfileText,
  profileUnit,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { KLINE_PROFILE, KWP_PROFILE, MINIMAL, edit } from "./support/profiles.js";

describe("shipped profiles", () => {
  it("every shipped profile loads", () => {
    expect(builtinProfiles()).toContain("mercedes-w211");
    for (const name of builtinProfiles()) {
      const profile = loadBuiltinProfile(name);
      expect(profile.name).toBe(name);
      expect([...profile.units.values()].every((unit) => unit.source !== "")).toBe(true);
    }
  });

  it("the W211 profile has its addresses", () => {
    const profile = loadBuiltinProfile("mercedes-w211");
    expect(canBus(profile)).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect([profile.protocol, profile.session]).toEqual(["kwp2000", 0x92]);
    expect(profile.status).toBe("unconfirmed");
    const esp = profileUnit(profile, "esp");
    expect([esp.requestId, esp.responseId]).toEqual([0x784, 0x785]);
    const engine = profileUnit(profile, "engine");
    expect([engine.requestId, engine.responseId]).toEqual([0x7e0, 0x7e8]);
  });

  it("the VAG MQB profile has its addresses", () => {
    const profile = loadBuiltinProfile("vag-mqb");
    expect(canBus(profile)).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect([profile.protocol, profile.session]).toEqual(["uds", 0x01]);
    expect(profile.status).toBe("unconfirmed");
    const pairs = new Map(
      [...profile.units].map(([name, unit]) => [name, [unit.requestId, unit.responseId]]),
    );
    expect(pairs.get("engine")).toEqual([0x7e0, 0x7e8]);
    expect(pairs.get("dashboard")).toEqual([0x714, 0x77e]);
    expect(pairs.get("hvac")).toEqual([0x746, 0x7b0]);
  });

  it("an unknown profile lists the shipped ones", () => {
    expect(() => builtinProfileData("no-such-car")).toThrow(/mercedes-w211/);
  });

  it("keeps the provenance notes of the file it was converted from", () => {
    expect(Reflect.get(Object(builtinProfileData("vag-mqb")), "notes")).toContain("community wiki");
  });
});

describe("parseProfile", () => {
  it("loads from JSON text", () => {
    const profile = parseProfileText(JSON.stringify(MINIMAL), "test");
    expect(profileUnit(profile, "engine").requestId).toBe(0x7e0);
  });

  it("lists the known units when one is unknown", () => {
    expect(() => profileUnit(parseProfile(MINIMAL, "test"), "gearbox")).toThrow(/engine/);
  });

  it.each([
    [
      "a session the guard does not allow",
      edit(MINIMAL, ["diagnostics", "session"], 0x02),
      /not a read-only session/,
    ],
    [
      "an unknown protocol",
      edit(MINIMAL, ["diagnostics", "protocol"], "j1939"),
      /protocol must be kwp2000 or uds/,
    ],
    ["a zero bit rate", edit(MINIMAL, ["bus", "bitrate"], 0), /bitrate must be positive/],
    [
      "an identifier width that is not CAN",
      edit(MINIMAL, ["bus", "id_bits"], 12),
      /id_bits must be 11 or 29/,
    ],
    [
      "a mistyped address",
      edit(MINIMAL, ["units", "engine", "request"], "7E0"),
      /request must be a whole number/,
    ],
    [
      "a missing response",
      edit(MINIMAL, ["units", "engine", "response"], undefined),
      /missing response/,
    ],
    ["a missing status", edit(MINIMAL, ["status"], undefined), /missing status/],
    ["no units", edit(MINIMAL, ["units"], {}), /no units/],
    ["a missing bus", edit(MINIMAL, ["bus"], undefined), /missing bus/],
  ])("refuses %s", (_label, data, message) => {
    expect(() => parseProfile(data, "test")).toThrow(ProfileError);
    expect(() => parseProfile(data, "test")).toThrow(message);
  });

  it("refuses text that is not JSON, naming the source", () => {
    expect(() => parseProfileText("{", "test")).toThrow(/^test: /);
  });

  it("allows a non-standard bit rate", () => {
    expect(canBus(parseProfile(edit(MINIMAL, ["bus", "bitrate"], 125000), "test")).bitrate).toBe(
      125_000,
    );
  });

  it("names the section of a problem", () => {
    const problems = (() => {
      try {
        parseProfile(edit(MINIMAL, ["units", "engine", "request"], "7E0"), "car.json");
      } catch (error) {
        if (error instanceof ProfileError) return error.problems;
        throw error;
      }
      return [];
    })();
    expect(problems).toEqual([
      'car.json [units.engine]: request must be a whole number, got "7E0"',
    ]);
  });
});

describe("K-line profiles", () => {
  it("default the tester and header format from the scheme", () => {
    const profile = parseProfile(KLINE_PROFILE, "test");
    expect(profile.bus).toEqual({
      kind: "kline",
      scheme: "kwp2000-fast",
      tester: 0xf1,
      headerFormat: 0xc0,
    });
    expect(() => canBus(profile)).toThrow(/K-line profile/);
  });

  it("take an explicit tester and header format", () => {
    const data = edit(edit(KLINE_PROFILE, ["bus", "tester"], 0xf2), ["bus", "header_format"], 0x80);
    expect(parseProfile(data, "test").bus).toMatchObject({ tester: 0xf2, headerFormat: 0x80 });
  });

  it.each([
    [
      "an unknown scheme",
      edit(KLINE_PROFILE, ["bus", "kline"], "kwp9000"),
      /kline must be one of iso9141/,
    ],
    [
      "a tester wider than a byte",
      edit(KLINE_PROFILE, ["bus", "tester"], 0x1f1),
      /tester must fit in one byte/,
    ],
    [
      "a protocol other than kwp2000",
      edit(KLINE_PROFILE, ["diagnostics", "protocol"], "uds"),
      /kwp2000 only/,
    ],
  ])("refuse %s", (_label, data, message) => {
    expect(() => parseProfile(data, "test")).toThrow(message);
  });
});

describe("named values", () => {
  const engine = (): ReturnType<typeof profileUnit> =>
    profileUnit(parseProfile(KWP_PROFILE, "test"), "engine");

  it("parse with defaults", () => {
    const value = engine().values.get("rail-temperature");
    expect(value).toMatchObject({
      offset: 0,
      size: 1,
      signed: true,
      scale: 1,
      bias: -40,
      unit: "°C",
    });
    if (value === undefined) throw new Error("no value");
    expect(decodeValue(value, Uint8Array.of(0xfb))).toBe(-45);
    expect(engine().values.get("refused")?.status).toBe("unconfirmed");
  });

  it("decode bytes at an offset, big-endian, scaled", () => {
    const value = engine().values.get("boost");
    if (value === undefined) throw new Error("no value");
    expect(decodeValue(value, Uint8Array.of(0x00, 0x0a, 0x28))).toBeCloseTo(260);
  });

  it.each([
    [
      "an identifier too wide for the protocol",
      ["units", "engine", "values", "rail-temperature", "identifier"],
      0x111,
      /does not fit a kwp2000 identifier/,
    ],
    [
      "a size over four bytes",
      ["units", "engine", "values", "boost", "size"],
      5,
      /size must be 1 to 4/,
    ],
    [
      "a scale that is not a number",
      ["units", "engine", "values", "boost", "scale"],
      "x",
      /scale must be a number/,
    ],
    ["a negative offset", ["units", "engine", "values", "boost", "offset"], -1, /offset must be/],
  ])("reject %s", (_label, path, value, message) => {
    expect(() => parseProfile(edit(KWP_PROFILE, path, value), "test")).toThrow(message);
  });

  it("refuse a reply that is too short", () => {
    const value = engine().values.get("boost");
    if (value === undefined) throw new Error("no value");
    expect(() => decodeValue(value, new Uint8Array(2))).toThrow(/3 are needed/);
  });

  it("allow a UDS two-byte identifier", () => {
    const data = edit(
      edit(edit(KWP_PROFILE, ["diagnostics", "protocol"], "uds"), ["diagnostics", "session"], 0x03),
      ["units", "engine", "values", "boost", "identifier"],
      0xf410,
    );
    expect(profileUnit(parseProfile(data, "test"), "engine").values.get("boost")?.identifier).toBe(
      0xf410,
    );
  });
});

describe("session allowlist", () => {
  it("accepts exactly the sessions the guard allows for service 0x10", () => {
    for (const protocol of PROFILE_PROTOCOLS) {
      const allowed = READ_ONLY[protocol].get(0x10);
      if (!(allowed instanceof Set)) throw new Error(`no session allowlist for ${protocol}`);
      for (let session = 0; session <= 0xff; session++) {
        expect(isReadOnlySession(protocol, session), `${protocol} ${String(session)}`).toBe(
          allowed.has(session),
        );
      }
    }
  });
});

describe("per-unit diagnostics", () => {
  const mixed = edit(MINIMAL, ["units", "gearbox"], {
    description: "Gearbox",
    request: 0x7e1,
    response: 0x7e9,
    diagnostics: { protocol: "kwp2000", session: 0x81 },
    source: "made up for the test",
  });

  it("a unit without its own diagnostics takes the profile's", () => {
    const unit = profileUnit(parseProfile(mixed, "mixed"), "engine");
    expect([unit.protocol, unit.session]).toEqual(["uds", 0x03]);
  });

  it("a unit with its own diagnostics keeps them beside the profile's", () => {
    const profile = parseProfile(mixed, "mixed");
    const unit = profileUnit(profile, "gearbox");
    expect([unit.protocol, unit.session]).toEqual(["kwp2000", 0x81]);
    expect([profile.protocol, profile.session]).toEqual(["uds", 0x03]);
  });

  it("a unit's session must be a read-only session of the unit's own protocol", () => {
    // 0x03 is a read-only UDS session and not a KWP2000 one.
    const bad = edit(mixed, ["units", "gearbox", "diagnostics", "session"], 0x03);
    expect(() => parseProfile(bad, "mixed")).toThrow(
      /\[units\.gearbox\.diagnostics\]: diagnostic session 0x03 is not a read-only session/,
    );
  });

  it("a value's identifier must fit the unit's protocol, not the profile's", () => {
    const wide = edit(mixed, ["units", "gearbox", "values"], {
      wide: { label: "wide", identifier: 0x1234, source: "made up for the test" },
    });
    expect(() => parseProfile(wide, "mixed")).toThrow(
      /\[units\.gearbox\.values\.wide\]: identifier 0x1234 does not fit a kwp2000 identifier/,
    );
  });

  it("a unit's diagnostics name a protocol the tool supports", () => {
    const bad = edit(mixed, ["units", "gearbox", "diagnostics", "protocol"], "obd");
    expect(() => parseProfile(bad, "mixed")).toThrow(/protocol must be kwp2000 or uds/);
  });

  it("a K-line unit's diagnostics cannot name UDS", () => {
    const bad = edit(KLINE_PROFILE, ["units"], {
      engine: {
        description: "Engine",
        request: 0x01,
        response: 0x02,
        diagnostics: { protocol: "uds", session: 0x01 },
        source: "made up for the test",
      },
    });
    expect(() => parseProfile(bad, "kline")).toThrow(/a K-line bus carries kwp2000 only/);
  });
});
