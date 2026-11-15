/**
 * The boundary between the screens and the diagnostic service.
 *
 * The screens call the oRPC client for the `DiagnosticsService` contract, whether it is served by the worker the page starts or, in tests, by a host in the same process. What a page alone can do (show a device picker inside a click) is a separate, small interface, because a worker cannot.
 */

import { ORPCError } from "@orpc/client";
import { TransportError, type DeviceGrant, type DiagnosticsClient } from "obd-read";

export type { DiagnosticsClient };

/** How the user chose to reach the car. */
export const ADAPTER_KINDS = ["webserial", "webbluetooth", "simulator"] as const;

/** A way of reaching the car. */
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** What only the page can do, because it needs a user gesture or an API a worker lacks. */
export interface PageDevices {
  /**
   * Opens the transport for `adapterUrl` on the page now (Web Bluetooth's picker), so the service's later connect adopts it. Must be the first thing a click handler awaits.
   */
  prepare(adapterUrl: string): Promise<void>;

  /** Shows the serial port picker and describes the port chosen. Must be the first thing a click handler awaits. */
  chooseSerial(): Promise<DeviceGrant>;
}

/** The service as the screens use it. */
export interface AppService {
  readonly client: DiagnosticsClient;
  readonly devices: PageDevices;
}

/** An operation the service refused or could not perform; the message is for the user. */
export class DiagnosticsError extends Error {
  override name = "DiagnosticsError";
}

/** The text to show for a failure of a service call, or `fallback` when the failure is not one a person can act on. */
export function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ORPCError) return error.message;
  if (error instanceof TransportError || error instanceof DiagnosticsError) return error.message;
  return fallback;
}
