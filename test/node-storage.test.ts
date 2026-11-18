import { describe, expect, it } from "vitest";
import { createNodeSqliteExecutor, openNodeStorage } from "../src/node/index.js";
import { DatabaseSync } from "node:sqlite";
import { openDrizzleStorage } from "../src/storage/index.js";
import { describeStorageContract, inventedCapture } from "./support/storage-contract.js";

describeStorageContract("Drizzle over node:sqlite", async () => {
  const storage = await openNodeStorage(":memory:");
  return {
    storage,
    dispose: () => {
      storage.close();
    },
  };
});

describe("Drizzle storage", () => {
  it("rolls back a run, a report or a capture whose sighting the register refuses", async () => {
    const database = new DatabaseSync(":memory:");
    const execute = createNodeSqliteExecutor(database);
    const storage = await openDrizzleStorage(execute);
    // One car carrying two plates at once, written past the storage as no call could leave it.
    await execute(
      "INSERT INTO vehicles (id, vin, label) VALUES ('v1', 'WDB2110202B000001', '')",
      [],
      "run",
    );
    await execute(
      "INSERT INTO vehicle_plates (id, vehicle_id, plate, valid_from, valid_to) VALUES ('a', 'v1', 'AB12CDE', 0, NULL), ('b', 'v1', 'XY65ZZZ', 10, NULL)",
      [],
      "run",
    );
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
    await expect(
      storage.saveCapture(inventedCapture("refused", 20), { origin: "local", ...sighting }),
    ).rejects.toThrow(/at once/);
    expect(await storage.listRuns()).toEqual([]);
    expect(await storage.listScanReports()).toEqual([]);
    expect(await storage.listCaptures()).toEqual([]);
    expect(await execute("SELECT count(*) FROM vehicle_plates", [], "all")).toEqual([[2]]);
    database.close();
  });
});

describe("openNodeStorage", () => {
  it("is exported with its executor", () => {
    expect(typeof createNodeSqliteExecutor).toBe("function");
  });
});
