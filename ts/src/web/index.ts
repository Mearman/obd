/**
 * Browser entry point: registers the `webserial` and `webbluetooth` transports with core.
 *
 * Importing this module has that effect. The `webusb` scheme is not served yet.
 */
import { registerTransport } from "../core/transport.js";
import { createWebBluetoothTransport } from "./bluetooth.js";
import { createWebSerialTransport } from "./serial.js";

registerTransport("webserial", (address) => createWebSerialTransport(address));
registerTransport("webbluetooth", (address) => createWebBluetoothTransport(address));

export * from "./bluetooth.js";
export * from "./capabilities.js";
export * from "./gatt.js";
export * from "./read-queue.js";
export * from "./serial.js";
export * from "./storage.js";
export * from "../service/message-port.js";
