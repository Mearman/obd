import { describe, expect, it } from "vitest";
import { DeviceGrants, TransportError } from "../src/core/index.js";
import {
  grantedSerialEnvironment,
  matchSerialGrant,
  matchUsbGrant,
  type GrantedSerialPort,
  type GrantedUsbDevice,
} from "../src/web/granted-devices.js";

function port(vendor: number | undefined, product: number | undefined): GrantedSerialPort {
  return {
    readable: null,
    writable: null,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getInfo: () => ({ usbVendorId: vendor, usbProductId: product }),
  };
}

function device(vendorId: number, productId: number, serialNumber?: string): GrantedUsbDevice {
  return {
    vendorId,
    productId,
    serialNumber,
    configuration: null,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: () => Promise.reject(new Error("unused")),
    controlTransferOut: () => Promise.reject(new Error("unused")),
    clearHalt: () => Promise.resolve(),
    transferIn: () => Promise.reject(new Error("unused")),
    transferOut: () => Promise.reject(new Error("unused")),
  };
}

describe("granted devices in a worker", () => {
  it("picks the granted serial port that matches the page's grant", () => {
    const wanted = port(0x0403, 0x6001);
    const ports = [port(0x1234, 0x0001), wanted];
    expect(matchSerialGrant(ports, { scheme: "webserial", vendorId: 0x0403 })).toBe(wanted);
    expect(matchSerialGrant(ports, { scheme: "webserial" })).toBe(ports[0]);
    expect(() => matchSerialGrant(ports, { scheme: "webserial", vendorId: 1 })).toThrow(
      TransportError,
    );
    expect(() => matchSerialGrant([], undefined)).toThrow(/granted to this worker/);
  });

  it("picks the granted USB device by ids and serial number", () => {
    const wanted = device(0x1d50, 0x606f, "A1");
    const devices = [device(0x1d50, 0x606f, "B2"), wanted];
    expect(matchUsbGrant(devices, { scheme: "webusb", vendorId: 0x1d50, serialNumber: "A1" })).toBe(
      wanted,
    );
    expect(() => matchUsbGrant(devices, { scheme: "webusb", serialNumber: "Z9" })).toThrow(
      TransportError,
    );
  });

  it("answers requestPort with the granted port instead of a picker", async () => {
    const grants = new DeviceGrants();
    grants.grant({ scheme: "webserial", vendorId: 0x0403 });
    const wanted = port(0x0403, 0x6001);
    const environment = grantedSerialEnvironment(grants, {
      getPorts: () => Promise.resolve([port(1, 1), wanted]),
    });
    expect(await environment.serial?.requestPort({ filters: [] })).toBe(wanted);

    const none = grantedSerialEnvironment(grants, { getPorts: () => Promise.resolve([]) });
    await expect(none.serial?.requestPort({ filters: [] })).rejects.toThrow(TransportError);
    expect(grantedSerialEnvironment(grants, undefined).serial).toBeUndefined();
  });
});
