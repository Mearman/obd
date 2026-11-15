/**
 * The shipped Toyota and Lexus profile: it validates, addresses every unit once, pins the address and protocol of each unit as docs/vehicles/japan-korea.md records them, and reads end to end on the scripted adapter through a KWP2000 service 21 unit and a UDS service 22 unit. Every request the tool sends a unit passes the guard for that unit's own protocol.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  GuardError,
  SIMULATED_KWP_RECORD,
  SIMULATED_UDS_RECORD,
  checkProfile,
  fromHex,
  hexNumber,
  makeClient,
  permit,
  readUnit,
  scan,
  simulatedCar,
  toUpperHex,
  type Profile,
  type ProfileProtocol,
  type Unit,
} from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "toyota-tnga";

const KWP = DiagProtocol.KWP2000;
const UDS = DiagProtocol.UDS;

/** Each unit's request identifier, response identifier and protocol, as the profile's notes and docs/vehicles/japan-korea.md record them. */
const UNITS: readonly (readonly [string, number, number, ProfileProtocol])[] = [
  ["engine", 0x7e0, 0x7e8, KWP],
  ["engine-700", 0x700, 0x708, UDS],
  ["transmission", 0x7e1, 0x7e9, KWP],
  ["transmission-701", 0x701, 0x709, UDS],
  ["hybrid-control", 0x7d2, 0x7da, UDS],
  ["hybrid-control-legacy", 0x7e2, 0x7ea, KWP],
  ["hv-battery", 0x747, 0x74f, UDS],
  ["hv-battery-legacy", 0x7e3, 0x7eb, KWP],
  ["unit-745", 0x745, 0x74d, UDS],
  ["abs", 0x7b0, 0x7b8, KWP],
  ["unit-7b1", 0x7b1, 0x7b9, UDS],
  ["steering-angle", 0x7b3, 0x7bb, UDS],
  ["combination-meter", 0x7c0, 0x7c8, KWP],
  ["hvac", 0x7c4, 0x7cc, KWP],
  ["srs", 0x780, 0x788, KWP],
  ["unit-7d0", 0x7d0, 0x7d8, KWP],
  ["eps", 0x7a1, 0x7a9, KWP],
  ["eps-7a0", 0x7a0, 0x7a8, KWP],
  ["srs-2", 0x784, 0x78c, KWP],
  ["hv-battery-713", 0x713, 0x71b, UDS],
  ["motor-generator-716", 0x716, 0x71e, UDS],
  ["motor-generator-724", 0x724, 0x72c, UDS],
  ["brake-730", 0x730, 0x738, UDS],
];

async function openedCar(profile: Profile): Promise<Elm> {
  const elm = new Elm(fakeTransport(simulatedCar(profile)));
  await elm.initialise();
  await elm.selectCan(11, 500_000);
  return elm;
}

describe("the shipped Toyota profile", () => {
  it("is registered", () => {
    expect(builtinProfiles()).toContain(NAME);
  });

  it("passes the profile check", () => {
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is unconfirmed, with every unit sourced and the bus the OBD socket's CAN", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.status).toBe("unconfirmed");
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    for (const unit of profile.units.values()) {
      expect(unit.source, unit.name).toMatch(/https:\/\//);
      expect(unit.source, unit.name).toMatch(/Not read from a car\.$/);
    }
  });

  it("addresses every unit with its own request and response identifier", () => {
    const units = [...loadBuiltinProfile(NAME).units.values()];
    expect(new Set(units.map((unit) => unit.requestId)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.responseId)).size).toBe(units.length);
    expect(
      new Set([...units.map((unit) => unit.requestId), ...units.map((unit) => unit.responseId)])
        .size,
    ).toBe(2 * units.length);
    expect(units.some((unit) => unit.extendedAddress !== undefined)).toBe(false);
  });

  it("holds exactly the units the docs record, each at its recorded pair and protocol", () => {
    const profile = loadBuiltinProfile(NAME);
    expect([...profile.units.keys()]).toEqual(UNITS.map(([name]) => name));
    for (const [name, request, response, protocol] of UNITS) {
      const unit = profile.units.get(name);
      if (unit === undefined) throw new Error(`${NAME} has no unit ${name}`);
      expect([
        name,
        hexNumber(unit.requestId, 3),
        hexNumber(unit.responseId, 3),
        unit.protocol,
      ]).toEqual([name, hexNumber(request, 3), hexNumber(response, 3), protocol]);
    }
  });

  it("names a session of its own on every unit whose protocol is not the profile's", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.protocol).toBe(UDS);
    for (const unit of profile.units.values()) {
      if (unit.protocol !== profile.protocol) {
        expect(unit.session, unit.name).toBe(0x81);
      }
    }
  });

  it("records the HV battery contradiction in its notes", () => {
    const notes = builtinProfileData(NAME);
    if (typeof notes !== "object" || notes === null || !("notes" in notes)) {
      throw new Error("the profile has no notes");
    }
    expect(notes.notes).toMatch(/place the HV battery on 0x7E3/);
    expect(notes.notes).toMatch(/header 7E2/);
  });
});

describe("the Toyota profile on the scripted adapter", () => {
  it("answers every unit, each with the services of its own protocol", async () => {
    const profile = loadBuiltinProfile(NAME);
    const elm = await openedCar(profile);
    const reports = await scan(elm, profile, { faults: true, freeze: false });
    expect(reports.map((report) => [report.unit, report.answered, report.notes])).toEqual(
      UNITS.map(([name]) => [name, true, []]),
    );
    for (const [report, [, , , protocol]] of reports.map((r, i) => [r, UNITS[i] ?? []] as const)) {
      const labels = [...report.identification.keys()];
      if (protocol === UDS) expect(labels, report.unit).toContain("VIN");
      else expect(labels, report.unit).toEqual(["identification"]);
    }
  });

  it("reads an identification through service 1A on the engine and service 22 on the hybrid unit", async () => {
    const profile = loadBuiltinProfile(NAME);
    const elm = await openedCar(profile);
    const engine = profile.units.get("engine");
    const hybrid = profile.units.get("hybrid-control");
    if (engine === undefined || hybrid === undefined) throw new Error("a unit is missing");
    const engineReport = await readUnit(elm, profile, engine, { faults: false, freeze: false });
    const hybridReport = await readUnit(elm, profile, hybrid, { faults: false, freeze: false });
    expect(engineReport.identification.get("identification")?.text).toContain("E280CDI");
    expect(hybridReport.identification.get("VIN")?.hex).not.toBe("");
  });

  it("reads one value through service 21 on a KWP2000 unit and service 22 on a UDS unit", async () => {
    const profile = loadBuiltinProfile(NAME);
    const elm = await openedCar(profile);
    for (const [name, record] of [
      ["hvac", SIMULATED_KWP_RECORD],
      ["hv-battery", SIMULATED_UDS_RECORD],
    ] as const) {
      const unit = profile.units.get(name);
      if (unit === undefined) throw new Error(`${NAME} has no unit ${name}`);
      await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
      const client = makeClient(elm, profile, unit);
      await client.start();
      expect(toUpperHex(await client.readValue(record[0]))).toBe(toUpperHex(record[1]));
    }
  });

  it("sends each unit only requests the guard permits for that unit's own protocol", async () => {
    const profile = loadBuiltinProfile(NAME);
    const car = simulatedCar(profile);
    const elm = new Elm(fakeTransport(car));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    car.sent.length = 0;
    await scan(elm, profile, { faults: true, freeze: true });
    const byRequestId = new Map([...profile.units.values()].map((unit) => [unit.requestId, unit]));
    let current: Unit | undefined;
    const requests = new Map<string, string[]>();
    for (const line of car.sent) {
      const header = /^ATSH([0-9A-F]{3})$/.exec(line);
      if (header?.[1] !== undefined) current = byRequestId.get(Number.parseInt(header[1], 16));
      else if (/^[0-9A-F]+$/.test(line)) {
        if (current === undefined)
          throw new Error(`request ${line} sent before any unit was addressed`);
        requests.set(current.name, [...(requests.get(current.name) ?? []), line]);
      }
    }
    expect([...requests.keys()]).toEqual(UNITS.map(([name]) => name));
    for (const unit of profile.units.values()) {
      for (const line of requests.get(unit.name) ?? []) {
        await expect(
          permit(unit.protocol, fromHex(line)),
          `${unit.name} ${line}`,
        ).resolves.toBeDefined();
      }
    }
  });

  it("refuses a write or a programming session on every unit's protocol", async () => {
    const profile = loadBuiltinProfile(NAME);
    for (const unit of profile.units.values()) {
      const protocol = unit.protocol;
      const write =
        protocol === UDS ? Uint8Array.of(0x2e, 0x01, 0x99, 0x00) : Uint8Array.of(0x3b, 0x99, 0x00);
      await expect(permit(protocol, write), unit.name).rejects.toBeInstanceOf(GuardError);
      await expect(permit(protocol, Uint8Array.of(0x10, 0x02)), unit.name).rejects.toBeInstanceOf(
        GuardError,
      );
    }
  });
});
