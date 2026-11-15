import { describe, expect, it } from "vitest";
import {
  Elm,
  adapterTransport,
  obdCommand,
  parseProfile,
  simulatedCar,
  simulatedTransport,
  simulationBanner,
  type Profile,
  type ProfileCommand,
} from "../src/core/index.js";
import { loadBuiltinProfile } from "../src/profiles/index.js";
import { MemoryFiles, runProfileCommand, type CommandRun } from "./helpers/command-rig.js";
import { WritableMemoryStore } from "./helpers/unit-rig.js";
import { MINIMAL } from "./support/profiles.js";

const W211 = loadBuiltinProfile("mercedes-w211");

/** Runs one command against a freshly simulated car of the profile. */
function drive(profile: Profile, command: ProfileCommand): Promise<CommandRun> {
  return runProfileCommand({ transport: simulatedTransport(profile), profile, command });
}

describe("the simulated car", () => {
  it("has every unit of a KWP2000 profile answer", async () => {
    const count = W211.units.size;
    const { status, lines } = await drive(W211, { command: "probe" });
    expect(status).toBe(0);
    expect(lines.join("\n")).toContain(`${String(count)} of ${String(count)} units answered`);
  });

  it("reads faults and freeze frames", async () => {
    const { status, lines } = await drive(W211, { command: "freeze", unit: "esp" });
    expect(status).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("1234  status 20");
    expect(output).toContain("freeze frame:");
  });

  it("simulates a UDS profile too", async () => {
    const profile = parseProfile(MINIMAL, "test");
    const { status, lines } = await drive(profile, { command: "scan", freeze: true });
    expect(status).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("VIN: ");
    expect(output).toContain("C12345  status 08");
    expect(output).toContain("1 of 1 units answered");
  });

  it("can be cleared, and each car starts fresh", async () => {
    const store = new WritableMemoryStore();
    const files = new MemoryFiles();
    const car = simulatedCar(W211);
    const transport = adapterTransport(car);
    const cleared = await runProfileCommand({
      transport,
      profile: W211,
      command: { command: "clear", unit: "esp", save: "before.json", yes: true },
      store,
      files,
    });
    expect(cleared.status).toBe(0);
    expect(cleared.lines.at(-1)).toBe("  fault codes: 0");
    const saved: unknown = JSON.parse(await store.readText("before.json"));
    const units: unknown = Reflect.get(Object(saved), "units");
    expect(Reflect.get(Object(Reflect.get(Object(units), 0)), "faults")).toEqual([
      { code: "1234", status: "20" },
    ]);
    const fresh = await drive(W211, { command: "faults", unit: "esp" });
    expect(fresh.lines.join("\n")).toContain("fault codes: 1");
  });

  it("answers legislated OBD-II requests", async () => {
    const elm = new Elm(simulatedTransport(W211));
    await elm.initialise();
    const lines: string[] = [];
    expect(
      await obdCommand(elm, { idBits: 11, bitrate: 500_000 }, (line) => lines.push(line)),
    ).toBe(0);
    expect(lines).toContain("VIN: SIMULATEDCAR00001");
    expect(lines).toContain("stored codes from 7E8: P0420");
  });

  it("announces where it listens", () => {
    const [first, second] = simulationBanner(W211, "127.0.0.1", 35000);
    expect(first).toBe(
      `simulating mercedes-w211 (${String(W211.units.size)} units) on tcp://127.0.0.1:35000`,
    );
    expect(second).toBe("each connection gets a fresh car; press Ctrl-C to stop");
  });
});
