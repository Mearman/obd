import { describe, expect, it } from "vitest";
import { DiagnosticsError } from "../src/diagnostics/client";
import { SIMULATED_VALUES, createSimulatorClient } from "../src/diagnostics/simulator";

describe("simulator client", () => {
  it("refuses hardware adapters with a message", async () => {
    const client = createSimulatorClient();
    await expect(
      client.connect({ kind: "webserial", showAllBluetoothDevices: false }),
    ).rejects.toThrow(DiagnosticsError);
  });

  it("requires a connection to scan", async () => {
    const client = createSimulatorClient();
    expect(() => client.scan("mercedes-w211")).toThrow(DiagnosticsError);
    const info = await client.connect({ kind: "simulator", showAllBluetoothDevices: false });
    expect(info.simulated).toBe(true);
    expect((await client.scan("mercedes-w211")).simulated).toBe(true);
  });

  it("streams the fixed values and ends when aborted", async () => {
    const client = createSimulatorClient();
    await client.connect({ kind: "simulator", showAllBluetoothDevices: false });
    const controller = new AbortController();
    const frames = [];
    for await (const frame of client.liveValues(controller.signal)) {
      frames.push(frame);
      controller.abort();
    }
    expect(frames).toEqual([{ sequence: 1, values: SIMULATED_VALUES }]);
  });
});
