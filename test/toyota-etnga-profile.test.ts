/**
 * The shipped toyota-etnga profile: it validates, carries the request and response pairs the OBDb bZ4X and Solterra repositories and the OVMS e-TNGA module agree on, all on UDS service 22, leaves out the mixed-addressed 0x750 units, and scans end to end on the scripted adapter.
 */

import { describe, expect, it } from "vitest";
import { DiagProtocol, Elm, checkProfile, scan, simulatedCar } from "../src/core/index.js";
import { builtinProfileData, builtinProfiles, loadBuiltinProfile } from "../src/profiles/index.js";
import { fakeTransport } from "./helpers/fake-elm.js";

const NAME = "toyota-etnga";

/** The request and response identifiers of every pair both sources give, by unit name. */
const AGREED: Readonly<Record<string, readonly [number, number]>> = {
  "plug-in-control": [0x745, 0x74d],
  "hv-battery": [0x747, 0x74f],
  abs: [0x7b0, 0x7b8],
  hvac: [0x7c4, 0x7cc],
  "hybrid-control": [0x7d2, 0x7da],
};

describe("the toyota-etnga profile", () => {
  it("is registered and passes the profile check", () => {
    expect(builtinProfiles()).toContain(NAME);
    expect(checkProfile(builtinProfileData(NAME), NAME)).toEqual([]);
  });

  it("is an unconfirmed UDS profile on 11-bit 500 kbit/s CAN", () => {
    const profile = loadBuiltinProfile(NAME);
    expect(profile.status).toBe("unconfirmed");
    expect([profile.protocol, profile.session]).toEqual([DiagProtocol.UDS, 0x01]);
    expect(profile.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
  });

  it("carries exactly the agreed pairs on UDS, each citing both sources", () => {
    const units = loadBuiltinProfile(NAME).units;
    expect(
      Object.fromEntries(
        [...units].map(([name, unit]) => [name, [unit.requestId, unit.responseId]]),
      ),
    ).toEqual(AGREED);
    for (const unit of units.values()) {
      expect(unit.extendedAddress).toBeUndefined();
      expect([unit.protocol, unit.session]).toEqual([DiagProtocol.UDS, 0x01]);
      expect(unit.source).toMatch(/https:\/\/github\.com\/OBDb\/Toyota-bZ4X\//);
      expect(unit.source).toMatch(/https:\/\/github\.com\/OBDb\/Subaru-Solterra\//);
      expect(unit.source).toMatch(/vehicle_toyota_etnga/);
    }
  });
});

describe("the toyota-etnga profile on the scripted adapter", () => {
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
