/**
 * Bluetooth LE link, for adapters that expose a serial-style notify and write pair.
 *
 * The radio sits behind {@link BleCentral} and {@link BlePeripheral}, so everything here (device
 * matching, picking the data channel, chunked writes, the transport) is testable without one.
 */

import { TransportError, type AdapterAddress, type Transport } from "../core/transport.js";
import { Inbox, errorText } from "./inbox.js";

/** What a characteristic allows. */
export type GattProperty = "read" | "write" | "write-without-response" | "notify" | "indicate";

/** One characteristic as the picker sees it: where it is and what it allows. UUIDs are canonical. */
export interface GattCharacteristic {
  readonly service: string;
  readonly uuid: string;
  readonly properties: readonly GattProperty[];
}

/** The pair of characteristics that carry the adapter's text interface. */
export interface DataChannel {
  readonly notify: string;
  readonly write: string;
  readonly writeWithResponse: boolean;
}

/** A device seen while scanning. `address` is the platform's identifier where there is no address. */
export interface BleAdvertisement {
  readonly id: string;
  readonly address: string;
  readonly name: string | undefined;
  readonly rssi: number;
}

/** A Bluetooth LE device that can be connected to. */
export interface BlePeripheral {
  /** Connects. Rejects if the device cannot be reached. */
  connect(): Promise<void>;
  /** Disconnects. Resolves when already disconnected. */
  disconnect(): Promise<void>;
  /** Lists every characteristic of every service. Only valid while connected. */
  characteristics(): Promise<readonly GattCharacteristic[]>;
  /** Delivers each notification of the characteristic (canonical UUID) to `onData`. */
  subscribe(characteristic: string, onData: (data: Uint8Array) => void): Promise<void>;
  /** Writes to the characteristic (canonical UUID), with or without a response. */
  write(characteristic: string, data: Uint8Array, withResponse: boolean): Promise<void>;
  /** Calls `listener` when the device disconnects for any reason, including a local disconnect. */
  onDisconnect(listener: () => void): void;
}

/** The host's Bluetooth LE radio. */
export interface BleCentral {
  /**
   * Scans for up to `timeoutMs` and returns every device seen, strongest signal first. The scan
   * ends early once `stopWhen` returns true for a device.
   */
  scan(
    timeoutMs: number,
    stopWhen?: (device: BleAdvertisement) => boolean,
  ): Promise<readonly BleAdvertisement[]>;
  /** The connectable device for an advertisement returned by {@link scan}. */
  peripheral(device: BleAdvertisement): BlePeripheral;
  /**
   * Releases the radio's native resources (its event loop handles) so the process can exit. A
   * central that never scanned has nothing to release. Safe to call more than once.
   */
  close(): void;
}

/** The smallest payload every Bluetooth LE link accepts in one write. */
export const MIN_WRITE_SIZE = 20;

/** How long {@link BleTransport.open} scans for the device by default. */
export const DEFAULT_SCAN_TIMEOUT_MS = 15_000;

/** Prefixes of the services every device carries that never hold the data channel. */
const STANDARD_SERVICES = ["00001800", "00001801", "0000180a"];

const BLUETOOTH_BASE = "-0000-1000-8000-00805f9b34fb";

/**
 * Writes a UUID in lower-case canonical form: 128 bits as `8-4-4-4-12` hex groups, a 16-bit short
 * form expanded onto the Bluetooth base UUID. Text that is neither is returned lower-cased.
 */
export function canonicalUuid(uuid: string): string {
  const bare = uuid.toLowerCase().replaceAll("-", "");
  if (/^[0-9a-f]{4}$/.test(bare)) return `0000${bare}${BLUETOOTH_BASE}`;
  if (/^[0-9a-f]{32}$/.test(bare)) {
    return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
  }
  return uuid.toLowerCase();
}

/**
 * Whether `uuid` starts with `wanted`, case-insensitively. A bare 16-bit form such as `18f0` also
 * matches the full UUID built on the Bluetooth base, which is how such UUIDs are usually written.
 */
function uuidMatches(uuid: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  const want = wanted.toLowerCase();
  const have = uuid.toLowerCase();
  return have.startsWith(want) || (/^[0-9a-f]{4}$/.test(want) && have.startsWith(`0000${want}`));
}

/**
 * Chooses the notify and write characteristics that carry the adapter's data.
 *
 * With no overrides, the first non-standard service holding both a notifying and a writable
 * characteristic is used. `service`, `notify` and `write` are UUIDs (or UUID prefixes) that narrow
 * or fix the choice.
 *
 * @throws TransportError when nothing fits.
 */
export function pickDataChannel(
  characteristics: readonly GattCharacteristic[],
  overrides: { service?: string; notify?: string; write?: string } = {},
): DataChannel {
  const byService = new Map<string, GattCharacteristic[]>();
  for (const characteristic of characteristics) {
    const service = characteristic.service.toLowerCase();
    if (STANDARD_SERVICES.some((prefix) => service.startsWith(prefix))) continue;
    if (!uuidMatches(characteristic.service, overrides.service)) continue;
    const members = byService.get(characteristic.service);
    if (members === undefined) byService.set(characteristic.service, [characteristic]);
    else members.push(characteristic);
  }
  for (const members of byService.values()) {
    const notifying = members.filter(
      (c) =>
        (c.properties.includes("notify") || c.properties.includes("indicate")) &&
        uuidMatches(c.uuid, overrides.notify),
    );
    const writable = members.filter(
      (c) =>
        (c.properties.includes("write") || c.properties.includes("write-without-response")) &&
        uuidMatches(c.uuid, overrides.write),
    );
    const notify = notifying[0];
    const target = writable[0];
    if (notify !== undefined && target !== undefined) {
      return {
        notify: notify.uuid,
        write: target.uuid,
        writeWithResponse: !target.properties.includes("write-without-response"),
      };
    }
  }
  throw new TransportError(
    "no service on this device has both a notifying and a writable characteristic; " +
      "run `obd-read adapters --inspect <name>` and pass service, notify and write in the URL",
  );
}

/**
 * Whether a scanned device is the one `target` names: its address or identifier equals `target`,
 * or its name contains `target`, ignoring case.
 */
export function matchesBleTarget(device: BleAdvertisement, target: string): boolean {
  const wanted = target.toLowerCase();
  const name = (device.name ?? "").toLowerCase();
  return (
    device.address.toLowerCase() === wanted ||
    device.id.toLowerCase() === wanted ||
    (name !== "" && name.includes(wanted))
  );
}

/** Optional narrowing of the data channel, from the `service`, `notify` and `write` URL parameters. */
export interface BleOptions {
  readonly service?: string;
  readonly notify?: string;
  readonly write?: string;
  /** How long to scan for the device; defaults to {@link DEFAULT_SCAN_TIMEOUT_MS}. */
  readonly scanTimeoutMs?: number;
}

interface OpenLink {
  readonly peripheral: BlePeripheral;
  readonly channel: DataChannel;
}

/** An ELM327 adapter reached over Bluetooth LE. */
export class BleTransport implements Transport {
  private link: OpenLink | undefined;
  private closing = false;
  private readonly inbox = new Inbox();

  /**
   * @param central The radio to scan and connect with.
   * @param target The device's name (or part of it), address or platform identifier.
   */
  constructor(
    private readonly central: BleCentral,
    private readonly target: string,
    private readonly options: BleOptions = {},
  ) {}

  /**
   * Finds the device, connects, picks the data channel and subscribes to its notifications.
   *
   * @throws TransportError if the device is not seen, cannot be connected to, or has no usable
   * data channel.
   */
  async open(): Promise<void> {
    if (this.link !== undefined) throw new TransportError("Bluetooth LE link is already open");
    const scanTimeoutMs = this.options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    const seen = await this.central.scan(scanTimeoutMs, (device) =>
      matchesBleTarget(device, this.target),
    );
    const device = seen.find((candidate) => matchesBleTarget(candidate, this.target));
    if (device === undefined) {
      throw new TransportError(
        `no Bluetooth LE device matching ${JSON.stringify(this.target)} seen in ${(scanTimeoutMs / 1000).toFixed(0)} s`,
      );
    }
    const peripheral = this.central.peripheral(device);
    this.inbox.reset();
    this.closing = false;
    peripheral.onDisconnect(() => {
      if (!this.closing) {
        this.inbox.fail(new TransportError("the Bluetooth LE device disconnected"));
      }
    });
    try {
      await peripheral.connect();
    } catch (error) {
      throw new TransportError(
        `cannot connect to ${JSON.stringify(this.target)}: ${errorText(error)}`,
      );
    }
    try {
      const channel = pickDataChannel(await peripheral.characteristics(), this.options);
      await peripheral.subscribe(channel.notify, (data) => {
        this.inbox.push(data);
      });
      this.link = { peripheral, channel };
    } catch (error) {
      this.closing = true;
      await peripheral.disconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    const link = this.link;
    if (link === undefined) return;
    this.link = undefined;
    this.closing = true;
    await link.peripheral.disconnect();
  }

  /** Writes in pieces of {@link MIN_WRITE_SIZE} bytes, each acknowledged before the next. */
  async write(data: Uint8Array): Promise<void> {
    const link = this.link;
    if (link === undefined) throw new TransportError("Bluetooth LE link is not open");
    for (let start = 0; start < data.length; start += MIN_WRITE_SIZE) {
      await link.peripheral.write(
        link.channel.write,
        data.slice(start, start + MIN_WRITE_SIZE),
        link.channel.writeWithResponse,
      );
    }
  }

  /**
   * Returns the notifications received since the last read, waiting up to `timeoutMs` for the first.
   *
   * @throws TransportTimeout when nothing arrives within `timeoutMs`.
   * @throws TransportError when the device has disconnected.
   */
  read(timeoutMs: number): Promise<Uint8Array> {
    return this.inbox.read(timeoutMs);
  }
}

/** Builds a {@link BleTransport} for a `ble://` address, reading `service`, `notify` and `write`. */
export function bleTransportFor(central: BleCentral, address: AdapterAddress): BleTransport {
  const service = address.params.get("service");
  const notify = address.params.get("notify");
  const write = address.params.get("write");
  return new BleTransport(central, address.target, {
    ...(service === undefined ? {} : { service }),
    ...(notify === undefined ? {} : { notify }),
    ...(write === undefined ? {} : { write }),
  });
}
