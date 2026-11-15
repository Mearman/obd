import { TransportError } from "../core/transport.js";

/** Services every Bluetooth LE device carries that never hold the adapter's data channel. */
const STANDARD_SERVICE_PREFIXES = ["00001800", "00001801", "0000180a"];

/** The smallest payload every Bluetooth LE link accepts in one write. */
export const MIN_WRITE_SIZE = 20;

const BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/** One characteristic as the picker sees it: where it is and what it allows. */
export interface GattCharacteristic {
  /** Full lower-case UUID of the owning service. */
  readonly service: string;
  /** Full lower-case UUID of the characteristic. */
  readonly uuid: string;
  /** Any of `notify`, `indicate`, `write` and `write-without-response`. */
  readonly properties: readonly string[];
}

/** The pair of characteristics that carry the adapter's text interface. */
export interface DataChannel {
  readonly service: string;
  readonly notify: string;
  readonly write: string;
  /** False when the write characteristic accepts writes without response, which is preferred. */
  readonly writeWithResponse: boolean;
}

/** Optional constraints from the adapter URL, each a full UUID or a prefix of one. */
export interface ChannelOverrides {
  readonly service?: string | undefined;
  readonly notify?: string | undefined;
  readonly write?: string | undefined;
}

/**
 * Lower-cases a UUID and expands the 16-bit (`18f0`) and 32-bit (`0000fff0`) short forms onto the
 * Bluetooth base UUID. Any other text is lower-cased and kept, so a UUID prefix still works.
 */
export function normaliseUuid(uuid: string): string {
  const lower = uuid.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(lower)) return `0000${lower}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(lower)) return `${lower}${BASE_UUID_SUFFIX}`;
  return lower;
}

/**
 * Chooses the notify and write characteristics that carry the adapter's data.
 *
 * With no overrides, the first non-standard service holding both a notifying (or indicating) and a
 * writable characteristic is used, the first of each. Overrides narrow or fix that choice.
 *
 * @throws TransportError when nothing fits.
 */
export function pickDataChannel(
  characteristics: readonly GattCharacteristic[],
  overrides: ChannelOverrides = {},
): DataChannel {
  const matches = (uuid: string, wanted: string | undefined): boolean =>
    wanted === undefined || uuid.startsWith(normaliseUuid(wanted));

  const byService = new Map<string, GattCharacteristic[]>();
  for (const characteristic of characteristics) {
    if (STANDARD_SERVICE_PREFIXES.some((prefix) => characteristic.service.startsWith(prefix))) {
      continue;
    }
    if (!matches(characteristic.service, overrides.service)) continue;
    const members = byService.get(characteristic.service);
    if (members === undefined) byService.set(characteristic.service, [characteristic]);
    else members.push(characteristic);
  }

  for (const [service, members] of byService) {
    const notifying = members.filter(
      (c) =>
        (c.properties.includes("notify") || c.properties.includes("indicate")) &&
        matches(c.uuid, overrides.notify),
    );
    const writable = members.filter(
      (c) =>
        (c.properties.includes("write") || c.properties.includes("write-without-response")) &&
        matches(c.uuid, overrides.write),
    );
    const notify = notifying[0];
    const write = writable[0];
    if (notify !== undefined && write !== undefined) {
      return {
        service,
        notify: notify.uuid,
        write: write.uuid,
        writeWithResponse: !write.properties.includes("write-without-response"),
      };
    }
  }
  throw new TransportError(
    "no service on this device has both a notifying and a writable characteristic; " +
      "pass service, notify and write in the adapter URL",
  );
}
