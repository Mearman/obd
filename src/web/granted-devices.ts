/**
 * Serial ports and USB devices a page granted, for transports that run in a dedicated worker.
 *
 * The browser's pickers (`requestPort`, `requestDevice`) need a user gesture on a page, so a worker cannot show one. The page runs the picker, describes the grant with {@link requestSerialGrant} or {@link requestUsbGrant} and sends the description to the service (`adapters.grant`). The worker's transports then use {@link grantedSerialEnvironment} and {@link grantedUsbEnvironment}, whose `requestPort` and `requestDevice` return the already granted device that matches the description instead of asking.
 *
 * That `navigator.serial` and `navigator.usb` exist in a dedicated worker and list the page's grants there is taken from MDN's pages for `WorkerNavigator.serial` and `WorkerNavigator.usb`; Chrome's own capability guides do not mention workers, and no worker run against hardware has been made.
 */

import { TransportError } from "../core/transport.js";
import type { DeviceGrants } from "../core/transport-host.js";
import type { DeviceGrant } from "../core/service.js";
import type { SerialEnvironment, SerialPortLike, SerialRequest } from "./serial.js";
import type { UsbDeviceLike, UsbEnvironment, UsbLike, UsbRequest } from "./usb.js";

/** The part of a granted serial port the worker reads to match it. */
export interface GrantedSerialPort extends SerialPortLike {
  getInfo(): {
    readonly usbVendorId?: number | undefined;
    readonly usbProductId?: number | undefined;
  };
}

/** The part of `navigator.serial` that lists granted ports. */
export interface SerialPortList {
  getPorts(): Promise<readonly GrantedSerialPort[]>;
}

/** The part of a granted USB device the worker reads to match it. */
export interface GrantedUsbDevice extends UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string | null | undefined;
}

/** The part of `navigator.usb` that lists granted devices and reports disconnects. */
export interface UsbDeviceList extends Pick<UsbLike, "addEventListener" | "removeEventListener"> {
  getDevices(): Promise<readonly GrantedUsbDevice[]>;
}

/**
 * The first port in `ports` that matches the grant's USB ids.
 *
 * A grant without ids (a paired Bluetooth serial adapter has none) matches the first port.
 *
 * @throws TransportError when no port matches.
 */
export function matchSerialGrant(
  ports: readonly GrantedSerialPort[],
  grant: DeviceGrant | undefined,
): GrantedSerialPort {
  const found = ports.find((port) => {
    const info = port.getInfo();
    return (
      (grant?.vendorId === undefined || info.usbVendorId === grant.vendorId) &&
      (grant?.productId === undefined || info.usbProductId === grant.productId)
    );
  });
  if (found === undefined) {
    throw new TransportError(
      "no serial port is granted to this worker: choose the adapter on the page first",
    );
  }
  return found;
}

/**
 * The first device in `devices` that matches the grant.
 *
 * @throws TransportError when no device matches.
 */
export function matchUsbGrant(
  devices: readonly GrantedUsbDevice[],
  grant: DeviceGrant | undefined,
): GrantedUsbDevice {
  const found = devices.find(
    (device) =>
      (grant?.vendorId === undefined || device.vendorId === grant.vendorId) &&
      (grant?.productId === undefined || device.productId === grant.productId) &&
      (grant?.serialNumber === undefined || device.serialNumber === grant.serialNumber),
  );
  if (found === undefined) {
    throw new TransportError(
      "no USB device is granted to this worker: choose the adapter on the page first",
    );
  }
  return found;
}

/**
 * A Web Serial environment whose `requestPort` returns the granted port instead of showing a picker.
 *
 * @param ports The browser's `navigator.serial`, or undefined where it has none.
 */
export function grantedSerialEnvironment(
  grants: DeviceGrants,
  ports: SerialPortList | undefined,
): SerialEnvironment {
  if (ports === undefined) return { serial: undefined };
  return {
    serial: {
      requestPort: async () =>
        matchSerialGrant(await ports.getPorts(), grants.granted("webserial")),
    },
  };
}

/**
 * A WebUSB environment whose `requestDevice` returns the granted device instead of showing a picker.
 *
 * @param usb The browser's `navigator.usb`, or undefined where it has none.
 */
export function grantedUsbEnvironment(
  grants: DeviceGrants,
  usb: UsbDeviceList | undefined,
): UsbEnvironment {
  if (usb === undefined) return { usb: undefined };
  return {
    usb: {
      requestDevice: async () => matchUsbGrant(await usb.getDevices(), grants.granted("webusb")),
      addEventListener: (type, listener) => {
        usb.addEventListener(type, listener);
      },
      removeEventListener: (type, listener) => {
        usb.removeEventListener(type, listener);
      },
    },
  };
}

/** `navigator.serial` of the running context, or undefined where it has none. */
export function browserSerialPorts(): SerialPortList | undefined {
  if (typeof navigator === "undefined" || !("serial" in navigator)) return undefined;
  return navigator.serial;
}

/** `navigator.usb` of the running context, or undefined where it has none. */
export function browserUsbDevices(): UsbDeviceList | undefined {
  if (typeof navigator === "undefined" || !("usb" in navigator)) return undefined;
  return navigator.usb;
}

/**
 * Shows the serial picker and describes the port the user chose. Call it from a click handler, on the page.
 *
 * @throws TransportError when Web Serial is missing or no port is chosen.
 */
export async function requestSerialGrant(request: SerialRequest): Promise<DeviceGrant> {
  if (typeof navigator === "undefined" || !("serial" in navigator)) {
    throw new TransportError("Web Serial is not available in this browser");
  }
  try {
    const info = (await navigator.serial.requestPort(request)).getInfo();
    return {
      scheme: "webserial",
      ...(info.usbVendorId === undefined ? {} : { vendorId: info.usbVendorId }),
      ...(info.usbProductId === undefined ? {} : { productId: info.usbProductId }),
    };
  } catch (error) {
    throw new TransportError(
      `no serial port was chosen: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Shows the USB picker and describes the device the user chose. Call it from a click handler, on the page.
 *
 * @throws TransportError when WebUSB is missing or no device is chosen.
 */
export async function requestUsbGrant(request: UsbRequest): Promise<DeviceGrant> {
  if (typeof navigator === "undefined" || !("usb" in navigator)) {
    throw new TransportError("WebUSB is not available in this browser");
  }
  try {
    const device = await navigator.usb.requestDevice(request);
    return {
      scheme: "webusb",
      vendorId: device.vendorId,
      productId: device.productId,
      ...(typeof device.serialNumber === "string" ? { serialNumber: device.serialNumber } : {}),
    };
  } catch (error) {
    throw new TransportError(
      `no USB device was chosen: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
