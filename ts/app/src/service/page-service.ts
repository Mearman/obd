import { openTransport } from "obd-read";
import {
  connectDiagnostics,
  requestSerialGrant,
  serveStorage,
  serveTransports,
} from "obd-read/web";
import type { AppService } from "../diagnostics/client";
import { StorageSource } from "./storage-source";

/** The service and what the page must keep feeding it. */
export interface PageService extends AppService {
  /** Set from the database's state; the worker's storage requests are answered from it. */
  readonly storage: StorageSource;
}

/**
 * Starts the service worker and connects to it.
 *
 * Three message channels join the page and the worker. On one the worker serves the diagnostics service and the page is the client. On the other two the page is the server: it serves the transports it owns (Web Bluetooth) and the storage it opened (the database), and the worker is the client of both.
 */
export function createPageService(): PageService {
  const diagnostics = new MessageChannel();
  const transports = new MessageChannel();
  const storageChannel = new MessageChannel();
  const storage = new StorageSource();
  const worker = new Worker(new URL("./service.worker.ts", import.meta.url), {
    type: "module",
    name: "obd-read-service",
  });
  worker.postMessage(
    {
      diagnostics: diagnostics.port1,
      transports: transports.port1,
      storage: storageChannel.port1,
    },
    [diagnostics.port1, transports.port1, storageChannel.port1],
  );
  const bridge = serveTransports(transports.port2, openTransport);
  serveStorage(storageChannel.port2, storage.current);
  return {
    client: connectDiagnostics(diagnostics.port2),
    devices: {
      prepare: (adapterUrl) => bridge.prepare(adapterUrl),
      chooseSerial: () => requestSerialGrant({ filters: [] }),
    },
    storage,
  };
}
