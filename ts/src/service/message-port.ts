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
 * Serves `host`'s router on `port` for as long as the port is open; each client message is answered on the same port. Call it from the worker that owns the storage and the collector.
 */
export function serveDiagnostics(host: DiagnosticsHost, port: SupportedMessagePort): void {
  new RPCHandler(host.router).upgrade(port);
}

/**
 * A client for a service served on the other end of `port`. Its calls and its live iterator behave as {@link DiagnosticsHost.client} does in process.
 */
export function connectDiagnostics(port: SupportedMessagePort): DiagnosticsClient {
  return createORPCClient(new RPCLink({ port }));
}

export type { SupportedMessagePort };
