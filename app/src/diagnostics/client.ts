/**
 * The boundary between the screens and whatever performs diagnostics. The screens depend only on
 * this interface; the simulator implements it today and the oRPC client for the diagnostic
 * service replaces it later without any UI change.
 */

/** How the user chose to reach the car. */
export const ADAPTER_KINDS = ["webserial", "webbluetooth", "simulator"] as const;

/** A way of reaching the car. */
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** What the user chose on the Connect screen. */
export interface ConnectRequest {
  readonly kind: AdapterKind;
  /** For `webbluetooth`: list every nearby device instead of only known adapter names. */
  readonly showAllBluetoothDevices: boolean;
}

/** An established connection. */
export interface ConnectionInfo {
  /** Short name of the adapter, for the interface. */
  readonly adapter: string;
  /** True when the data does not come from a car. */
  readonly simulated: boolean;
}

/** One value read from the car. */
export interface LiveValue {
  readonly name: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
}

/** A batch of live values; `sequence` rises by one per batch. */
export interface LiveFrame {
  readonly sequence: number;
  readonly values: readonly LiveValue[];
}

/** One control unit's scan result. */
export interface UnitScan {
  readonly unit: string;
  readonly description: string;
  readonly faultCount: number;
  readonly responded: boolean;
}

/** The outcome of scanning a car with one profile. */
export interface ScanResult {
  readonly profile: string;
  readonly units: readonly UnitScan[];
  readonly simulated: boolean;
}

/** A stored collection run. */
export interface RunSummary {
  readonly id: string;
  readonly profile: string;
  readonly startedAt: string;
  readonly samples: number;
  readonly simulated: boolean;
}

/** An operation the service refused or could not perform; the message is for the user. */
export class DiagnosticsError extends Error {
  override name = "DiagnosticsError";
}

/**
 * Diagnostic operations as the screens use them.
 *
 * Every method rejects with {@link DiagnosticsError} when the operation cannot be done, with a
 * message fit to show. Read-only guarding happens behind this interface, never in the UI.
 */
export interface DiagnosticsClient {
  /** Opens the adapter the request names. Resolves once the adapter is ready to use. */
  connect(request: ConnectRequest): Promise<ConnectionInfo>;
  /** Closes the connection. Resolves when already closed. */
  disconnect(): Promise<void>;
  /** Scans every unit of the named profile. Requires a connection. */
  scan(profile: string): Promise<ScanResult>;
  /**
   * Streams live values until `signal` aborts, at least one frame per second. Requires a
   * connection. The iterator ends when the signal aborts.
   */
  liveValues(signal: AbortSignal): AsyncIterable<LiveFrame>;
  /** Lists stored collection runs, newest first. */
  runs(): Promise<readonly RunSummary[]>;
}
