import { parseSimulatorUrl } from "obd-read";
import { describe, expect, it } from "vitest";
import { SIMULATED_CODE_WINDOW, adapterUrl } from "../src/connect/adapters";

const OFF = { showAllBluetoothDevices: false, simulatedCodeChanges: false };

describe("adapterUrl", () => {
  it("names the plain simulator unless codes that come and go are asked for", () => {
    expect(adapterUrl("simulator", undefined, OFF)).toBe("simulator://generic-obd2");
    expect(adapterUrl("simulator", "mercedes-w211", OFF)).toBe("simulator://mercedes-w211");
  });

  it("carries the pending code window to the simulator when asked", () => {
    const url = adapterUrl("simulator", "mercedes-w211", { ...OFF, simulatedCodeChanges: true });
    expect(parseSimulatorUrl(url)).toEqual({
      profile: "mercedes-w211",
      pendingCode: SIMULATED_CODE_WINDOW,
    });
  });

  it("leaves hardware URLs untouched by the simulator option", () => {
    const codes = { ...OFF, simulatedCodeChanges: true };
    expect(adapterUrl("webserial", undefined, codes)).toBe("webserial://adapter");
    expect(adapterUrl("webbluetooth", undefined, codes)).toBe("webbluetooth://vLinker");
    expect(adapterUrl("webbluetooth", undefined, { ...codes, showAllBluetoothDevices: true })).toBe(
      "webbluetooth://adapter?all=1",
    );
  });
});
