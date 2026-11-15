/**
 * Browser entry point: registers the `webserial`, `webbluetooth` and `webusb` transports with core.
 *
 * Importing this module has that effect.
 */
import { registerTransport } from "../core/transport.js";
import { createWebBluetoothTransport } from "./bluetooth.js";
import { createWebSerialTransport } from "./serial.js";
import { createWebUsbTransport } from "./usb.js";

registerTransport("webserial", (address) => createWebSerialTransport(address));
registerTransport("webbluetooth", (address) => createWebBluetoothTransport(address));
registerTransport("webusb", (address) => createWebUsbTransport(address));

export * from "./bluetooth.js";
export * from "./capabilities.js";
export * from "./gatt.js";
export * from "./granted-devices.js";
export * from "./read-queue.js";
export * from "./serial.js";
export * from "./storage.js";
export * from "../service/message-port.js";
export * from "../service/transport-link.js";
export * from "./worker-host.js";
export * from "./usb.js";
