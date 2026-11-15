/**
 * The Node entry point, `obd-read/node`. Importing it registers the transports Node can build
 * (`serial`, `tcp`, `ble`, `slcan` and `socketcan`) with the core registry, so `openTransport`
 * serves those schemes. Native modules (`serialport`, noble, `socketcan`) load only when a serial
 * port, radio or CAN interface is first used.
 */

import { registerTransport } from "../core/transport.js";
import { bleTransportFor } from "./ble.js";
import { createNobleCentral } from "./noble.js";
import { serialTransportFor } from "./serial.js";
import { slcanTransportFor } from "./slcan.js";
import { socketcanTransportFor } from "./socketcan.js";
import { tcpTransportFor } from "./tcp.js";

export * from "./adapters.js";
export * from "./ble.js";
export * from "./noble.js";
export * from "./serial.js";
export * from "./storage.js";
export * from "./slcan.js";
export * from "./socketcan.js";
export * from "./tcp.js";

const bleCentral = createNobleCentral();

registerTransport("serial", serialTransportFor);
registerTransport("slcan", (address) => slcanTransportFor(address));
registerTransport("socketcan", (address) => socketcanTransportFor(address));
registerTransport("tcp", tcpTransportFor);
registerTransport("ble", (address) => bleTransportFor(bleCentral, address));
export * from "../service/message-port.js";
