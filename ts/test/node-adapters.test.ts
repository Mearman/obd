import { describe, expect, it } from "vitest";
import { TransportError } from "../src/core/index.js";
import {
  discoverAdapters,
  formatAdapterListing,
  formatInspection,
  inspectDevice,
} from "../src/node/adapters.js";
import { FakeCentral, FakePeripheral } from "./helpers/fake-ble.js";

const DATA = "000018f0-0000-1000-8000-00805f9b34fb";
const peripheral = new FakePeripheral([
  { service: DATA, uuid: "00002af0", properties: ["notify"] },
  { service: DATA, uuid: "00002af1", properties: ["write", "write-without-response"] },
]);
const central = new FakeCentral([
  { device: { id: "a", address: "A", name: undefined, rssi: -90 }, peripheral },
  { device: { id: "b", address: "B:B", name: "vLinker FD", rssi: -30 }, peripheral },
]);

describe("discoverAdapters", () => {
  it("lists devices strongest first and serial ports by path, in the CLI's format", async () => {
    const listing = await discoverAdapters(central, 8000, () =>
      Promise.resolve([
        { path: "/dev/tty.usbserial-2", description: "FTDI" },
        { path: "/dev/tty.Bluetooth", description: "n/a" },
      ]),
    );
    expect(central.scans).toContain(8000);
    expect(formatAdapterListing(listing)).toEqual([
      "Bluetooth LE devices:",
      "  vLinker FD  B:B  signal -30 dBm",
      "  (no name)  A  signal -90 dBm",
      "Serial ports:",
      "  /dev/tty.Bluetooth  n/a",
      "  /dev/tty.usbserial-2  FTDI",
    ]);
  });
});

describe("inspectDevice", () => {
  it("connects, lists the characteristics grouped by service and disconnects", async () => {
    const inspection = await inspectDevice(central, "vlinker", 8000);
    expect(peripheral.connected).toBe(false);
    expect(formatInspection(inspection)).toEqual([
      "vLinker FD  B:B",
      `  service ${DATA}`,
      "    characteristic 00002af0  notify",
      "    characteristic 00002af1  write, write-without-response",
    ]);
  });

  it("disconnects even when listing fails, and says when nothing matches", async () => {
    const broken = new FakePeripheral([]);
    broken.characteristics = () => Promise.reject(new Error("gatt failed"));
    const fake = new FakeCentral([
      { device: { id: "c", address: "C", name: "Broken", rssi: -1 }, peripheral: broken },
    ]);
    await expect(inspectDevice(fake, "broken", 1000)).rejects.toThrow("gatt failed");
    expect(broken.disconnects).toBe(1);
    await expect(inspectDevice(fake, "absent", 2000)).rejects.toThrow(TransportError);
  });
});
