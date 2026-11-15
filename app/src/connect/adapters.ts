import { simulatorUrl } from "obd-read";
import type { AdapterKind } from "../diagnostics/client";

/** The Bluetooth LE name prefix the picker is limited to unless the user lists every device. */
export const KNOWN_BLUETOOTH_PREFIX = "vLinker";

/**
 * The adapter URL for a choice on the Connect screen. The target of a browser scheme is only a label, because the browser's picker chooses the device.
 */
export function adapterUrl(
  kind: AdapterKind,
  profile: string,
  showAllBluetoothDevices: boolean,
): string {
  switch (kind) {
    case "simulator":
      return simulatorUrl(profile);
    case "webbluetooth":
      return showAllBluetoothDevices
        ? "webbluetooth://adapter?all=1"
        : `webbluetooth://${KNOWN_BLUETOOTH_PREFIX}`;
    case "webserial":
      return "webserial://adapter";
  }
}
