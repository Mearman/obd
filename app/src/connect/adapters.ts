import { GENERIC_PROFILE, simulatorUrl, type PendingCodeWindow } from "obd-read";
import type { AdapterKind } from "../diagnostics/client";

/** The Bluetooth LE name prefix the picker is limited to unless the user lists every device. */
export const KNOWN_BLUETOOTH_PREFIX = "vLinker";

/**
 * The reads of the pending code list that report the simulator's pending code when the person asks for codes that come and go. A recording plan reads the list once as each wait begins and again on every watch, so the code appears on the second read and is still there when a following wait takes its baseline, then clears.
 */
export const SIMULATED_CODE_WINDOW: PendingCodeWindow = { firstRead: 2, lastRead: 3 };

/** The choices in the Connection section's Options card. */
export interface ConnectOptions {
  /** List every nearby Bluetooth device in the browser's picker, not only {@link KNOWN_BLUETOOTH_PREFIX} names. */
  readonly showAllBluetoothDevices: boolean;
  /** Give the simulated car a pending code that appears and clears ({@link SIMULATED_CODE_WINDOW}). */
  readonly simulatedCodeChanges: boolean;
}

/**
 * The adapter URL for a choice in the Connection section. A simulated car with no profile is `simulator://generic-obd2`. The target of a browser scheme is only a label, because the browser's picker chooses the device.
 */
export function adapterUrl(
  kind: AdapterKind,
  profile: string | undefined,
  options: ConnectOptions,
): string {
  switch (kind) {
    case "simulator":
      return simulatorUrl(
        profile ?? GENERIC_PROFILE,
        options.simulatedCodeChanges ? { pendingCode: SIMULATED_CODE_WINDOW } : {},
      );
    case "webbluetooth":
      return options.showAllBluetoothDevices
        ? "webbluetooth://adapter?all=1"
        : `webbluetooth://${KNOWN_BLUETOOTH_PREFIX}`;
    case "webserial":
      return "webserial://adapter";
  }
}
