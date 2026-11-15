/**
 * The Node entry point, `obd-read/node`. Importing it registers the transports Node can build
 * (`serial`, `tcp` and `ble`) with the core registry, so `openTransport` serves those schemes.
 * Native modules (`serialport`, noble) load only when a serial port or radio is first used.
 */

import { registerTransport } from "../core/transport.js";
import { bleTransportFor } from "./ble.js";
import { createNobleCentral } from "./noble.js";
import { serialTransportFor } from "./serial.js";
import { tcpTransportFor } from "./tcp.js";

export * from "./adapters.js";
export * from "./ble.js";
export * from "./noble.js";
export * from "./serial.js";
export * from "./tcp.js";

const bleCentral = createNobleCentral();

registerTransport("serial", serialTransportFor);
registerTransport("tcp", tcpTransportFor);
registerTransport("ble", (address) => bleTransportFor(bleCentral, address));
