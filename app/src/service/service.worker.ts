/**
 * The dedicated worker that owns the diagnostic service: the collector and the polling loop.
 *
 * It waits for the page's start-up message and serves the service on the port the page gave it. Storage is the page's database, reached over a port. Web Serial and WebUSB transports run here; Web Bluetooth stays on the page and is reached over another port.
 */

import { remoteStorage, startDiagnosticsWorker } from "obd-read/web";
import { APP_VERSION } from "../release/release";
import { readWorkerInit } from "./protocol";

self.addEventListener(
  "message",
  (event: MessageEvent<unknown>) => {
    const init = readWorkerInit(event.data);
    if (init === undefined) return;
    startDiagnosticsWorker({
      storage: remoteStorage(init.storage),
      diagnosticsPort: init.diagnostics,
      transportPort: init.transports,
      toolVersion: APP_VERSION,
    });
  },
  { once: true },
);
