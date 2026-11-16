/**
 * The release of noble's native handles, with `@stoprocent/noble` replaced by a module double that records what is called on it. Whether the real module's `stop()` leaves the process with no active handles needs a Bluetooth adapter, so it is not checked here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const radio = vi.hoisted(() => {
  const listeners = new Set<unknown>();
  const state = { imports: 0, stops: 0, scans: 0, poweredOn: true };
  const noble = {
    waitForPoweredOnAsync: (): Promise<void> =>
      state.poweredOn ? Promise.resolve() : Promise.reject(new Error("adapter is powered off")),
    startScanningAsync: (): Promise<void> => {
      state.scans += 1;
      return Promise.resolve();
    },
    stopScanningAsync: (): Promise<void> => Promise.resolve(),
    on: (_event: string, listener: unknown): void => {
      listeners.add(listener);
    },
    removeListener: (_event: string, listener: unknown): void => {
      listeners.delete(listener);
    },
    stop: (): void => {
      state.stops += 1;
    },
  };
  return { state, listeners, noble };
});

vi.mock("@stoprocent/noble", () => {
  radio.state.imports += 1;
  return { default: radio.noble };
});

// `obd-read adapters` lists serial ports after the scan; the double keeps the host's ports out of the test.
vi.mock("serialport", () => ({ SerialPort: { list: () => Promise.resolve([]) } }));

const { createNobleCentral } = await import("../src/node/noble.js");
const { main } = await import("../src/node/cli.js");

beforeEach(() => {
  radio.state.stops = 0;
  radio.state.scans = 0;
  radio.state.poweredOn = true;
  radio.listeners.clear();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the noble central's close", () => {
  it("loads and stops nothing when no scan was made", () => {
    const importsBefore = radio.state.imports;
    createNobleCentral().close();
    expect(radio.state.stops).toBe(0);
    expect(radio.state.imports).toBe(importsBefore);
  });

  it("stops noble after a scan, with the discovery listener already removed", async () => {
    const central = createNobleCentral();
    expect(await central.scan(0)).toEqual([]);
    expect(radio.state.scans).toBe(1);
    expect(radio.listeners.size).toBe(0);
    expect(radio.state.stops).toBe(0);
    central.close();
    expect(radio.state.stops).toBe(1);
  });

  it("stops noble after a scan that failed because the radio is off", async () => {
    radio.state.poweredOn = false;
    const central = createNobleCentral();
    await expect(central.scan(0)).rejects.toThrow("Bluetooth is not available");
    central.close();
    expect(radio.state.stops).toBe(1);
  });
});

describe("the command line's exit path", () => {
  it("stops the process radio once when a Bluetooth command succeeds", async () => {
    const sigint = process.listenerCount("SIGINT");
    expect(await main(["adapters", "--timeout", "0"])).toBe(0);
    expect(radio.state.scans).toBe(1);
    expect(radio.state.stops).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
  });

  it("stops the process radio once when a Bluetooth command fails", async () => {
    radio.state.poweredOn = false;
    const sigint = process.listenerCount("SIGINT");
    expect(await main(["adapters", "--timeout", "0"])).toBe(1);
    expect(radio.state.stops).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
  });
});
