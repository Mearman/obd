/**
 * The diagnostics service as a dedicated worker runs it.
 *
 * The worker owns storage, the collector and the polling loop, so a page that is busy rendering never delays a poll. Transports are split by what the browser allows:
 *
 * - `webserial` and `webusb` run in the worker (both APIs are exposed to dedicated workers, see {@link ./granted-devices.ts}); the page runs the picker and grants the device.
 * - `webbluetooth` stays on the page because Web Bluetooth is not exposed to workers; the worker reaches it through {@link remoteTransportHost}.
 * - `simulator://` is served in the worker and needs no hardware.
 */

import { parseAdapterUrl, type Scheme } from "../core/transport.js";
import {
  composeTransportHosts,
  DeviceGrants,
  schemeTransportHost,
  type TransportHost,
} from "../core/transport-host.js";
import {
  profileLoader,
  createDiagnosticsService,
  type DiagnosticsService,
} from "../core/service-compose.js";
import { simulatorTransportHost } from "../core/simulator-host.js";
import type { Storage } from "../core/storage.js";
import { shippedPlans } from "../plans/index.js";
import { builtinProfileData } from "../profiles/index.js";
import { serveDiagnostics, type SupportedMessagePort } from "../service/message-port.js";
import { remoteTransportHost } from "../service/transport-link.js";
import {
  browserSerialPorts,
  browserUsbDevices,
  grantedSerialEnvironment,
  grantedUsbEnvironment,
} from "./granted-devices.js";
import { createWebSerialTransport } from "./serial.js";
import { createWebUsbTransport } from "./usb.js";

/** The schemes whose transports run inside the worker. */
export const WORKER_SCHEMES: readonly Scheme[] = ["webserial", "webusb"];

/** The schemes whose transports stay on the page, because the browser does not expose their API to workers. */
export const PAGE_SCHEMES: readonly Scheme[] = ["webbluetooth"];

/** What the worker is started with. */
export interface DiagnosticsWorkerOptions {
  /** The opened storage; the worker is its only user. */
  readonly storage: Storage;
  /** The port the page's diagnostics client talks to. */
  readonly diagnosticsPort: SupportedMessagePort;
  /** The port the page serves its transports on. */
  readonly transportPort: SupportedMessagePort;
  /** The app's version, as captures record it. */
  readonly toolVersion: string;
}

/** The transports a worker serves itself: Web Serial and WebUSB over the grants the page makes. */
export function workerTransportHost(grants: DeviceGrants): TransportHost {
  const serial = grantedSerialEnvironment(grants, browserSerialPorts());
  const usb = grantedUsbEnvironment(grants, browserUsbDevices());
  return schemeTransportHost(WORKER_SCHEMES, (adapterUrl) => {
    const address = parseAdapterUrl(adapterUrl);
    return address.scheme === "webusb"
      ? createWebUsbTransport(address, usb)
      : createWebSerialTransport(address, serial);
  });
}

/** Builds the service from `options` and serves it on `options.diagnosticsPort`. */
export function startDiagnosticsWorker(options: DiagnosticsWorkerOptions): DiagnosticsService {
  const grants = new DeviceGrants();
  const loadProfile = profileLoader(options.storage, builtinProfileData);
  const service = createDiagnosticsService({
    storage: options.storage,
    loadProfile,
    grants,
    toolVersion: options.toolVersion,
    plans: shippedPlans,
    transports: composeTransportHosts(
      simulatorTransportHost(loadProfile),
      workerTransportHost(grants),
      remoteTransportHost(options.transportPort, PAGE_SCHEMES),
    ),
  });
  serveDiagnostics(service.host, options.diagnosticsPort);
  return service;
}
