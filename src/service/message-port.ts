/**
 * The diagnostics service over a message port: how the PWA's page talks to its collector worker, and how a Node worker thread talks to its parent.
 *
 * Both halves use oRPC's message-port adapter. A `MessagePort`, a `Worker` and a Node `worker_threads` port all qualify; messages are structured-cloned, so they carry plain data only. Live samples cross the port as an async iterator.
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink, type SupportedMessagePort } from "@orpc/client/message-port";
import { RPCHandler } from "@orpc/server/message-port";
import type { DiagnosticsClient, DiagnosticsHost } from "../core/service-impl.js";

/**
 * Starts delivering messages on `port`.
 *
 * A browser `MessagePort` that is only listened to with `addEventListener` queues its messages until `start()` is called, and the oRPC adapters listen that way, so every port handed to them is started first. Ports of other kinds (a Node `parentPort`, an extension port) deliver on their own.
 */
export function startPort(port: SupportedMessagePort): void {
  if (port instanceof MessagePort) port.start();
}

/**
 * Serves `host`'s router on `port` for as long as the port is open; each client message is answered on the same port. Call it from the worker that owns the storage and the collector.
 */
export function serveDiagnostics(host: DiagnosticsHost, port: SupportedMessagePort): void {
  new RPCHandler(host.router).upgrade(port);
  startPort(port);
}

/**
 * A client for a service served on the other end of `port`. Its calls and its live iterator behave as {@link DiagnosticsHost.client} does in process.
 */
export function connectDiagnostics(port: SupportedMessagePort): DiagnosticsClient {
  const client: DiagnosticsClient = createORPCClient(new RPCLink({ port }));
  startPort(port);
  return client;
}

export type { SupportedMessagePort };
