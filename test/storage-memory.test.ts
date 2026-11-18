import { describe, expect, it } from "vitest";
import { MemoryStorage, type VehicleRegister } from "../src/core/index.js";
import { describeStorageContract } from "./support/storage-contract.js";

describeStorageContract("in-memory", () =>
  Promise.resolve({ storage: new MemoryStorage(), dispose: () => undefined }),
);

/** A register the rules refuse: one car carrying two plates at once, as no call could leave it. */
const CONTRADICTORY: VehicleRegister = {
  vehicles: [{ id: "v1", vin: "WDB2110202B000001", label: "" }],
  plates: [
    { id: "a", vehicleId: "v1", plate: "AB12CDE", validFrom: 0, validTo: null },
    { id: "b", vehicleId: "v1", plate: "XY65ZZZ", validFrom: 10, validTo: null },
  ],
};

describe("in-memory storage", () => {
  it("saves nothing of a run, a report or a capture whose sighting the register refuses", async () => {
    const storage = new MemoryStorage(undefined, CONTRADICTORY);
    const sighting = { vin: "WDB2110202B000001", plate: "NEW1" };
    await expect(
      storage.createRun({ profile: "p", adapter: "a", startedAt: 20, ...sighting }),
    ).rejects.toThrow(/at once/);
    await expect(
      storage.saveScanReport({
        profile: "p",
        adapter: "a",
        takenAt: 20,
        report: { obd: { vin: sighting.vin } },
        plate: sighting.plate,
      }),
    ).rejects.toThrow(/at once/);
    expect(await storage.listRuns()).toEqual([]);
    expect(await storage.listScanReports()).toEqual([]);
    expect(await storage.getVehicleRegister()).toEqual(CONTRADICTORY);
  });
});
