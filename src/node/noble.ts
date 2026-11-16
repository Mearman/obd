/**
 * The Bluetooth LE radio through `@stoprocent/noble`: a thin wrapper that only translates between
 * noble's objects and the {@link BleCentral} interface. The test suite has no radio: it checks the
 * scan and the release of the radio against a double of the noble module, and the behaviour above
 * this wrapper against a fake peripheral.
 */

import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble";
import { TransportError } from "../core/transport.js";
import {
  canonicalUuid,
  type BleAdvertisement,
  type BleCentral,
  type BlePeripheral,
  type GattCharacteristic,
  type GattProperty,
} from "./ble.js";
import { errorText } from "./inbox.js";

/** How long to wait for the host's Bluetooth adapter to report that it is powered on. */
const POWER_ON_TIMEOUT_MS = 10_000;

function gattProperty(property: string): GattProperty | undefined {
  switch (property) {
    case "read":
    case "write":
    case "notify":
    case "indicate":
      return property;
    case "writeWithoutResponse":
      return "write-without-response";
    default:
      return undefined;
  }
}

class NoblePeripheral implements BlePeripheral {
  private readonly characteristicsByUuid = new Map<string, Characteristic>();

  constructor(private readonly peripheral: Peripheral) {}

  async connect(): Promise<void> {
    await this.peripheral.connectAsync();
  }

  async disconnect(): Promise<void> {
    if (this.peripheral.state === "disconnected") return;
    await this.peripheral.disconnectAsync();
  }

  async characteristics(): Promise<readonly GattCharacteristic[]> {
    const { services } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    this.characteristicsByUuid.clear();
    const found: GattCharacteristic[] = [];
    for (const service of services) {
      for (const characteristic of service.characteristics) {
        const uuid = canonicalUuid(characteristic.uuid);
        if (!this.characteristicsByUuid.has(uuid))
          this.characteristicsByUuid.set(uuid, characteristic);
        found.push({
          service: canonicalUuid(service.uuid),
          uuid,
          properties: characteristic.properties.flatMap((p) => gattProperty(p) ?? []),
        });
      }
    }
    return found;
  }

  async subscribe(characteristic: string, onData: (data: Uint8Array) => void): Promise<void> {
    const target = this.lookup(characteristic);
    target.on("data", (data: Uint8Array) => {
      onData(new Uint8Array(data));
    });
    await target.subscribeAsync();
  }

  async write(characteristic: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    await this.lookup(characteristic).writeAsync(Buffer.from(data), !withResponse);
  }

  onDisconnect(listener: () => void): void {
    this.peripheral.once("disconnect", listener);
  }

  private lookup(uuid: string): Characteristic {
    const characteristic = this.characteristicsByUuid.get(uuid);
    if (characteristic === undefined) {
      throw new TransportError(`the device has no characteristic ${uuid}`);
    }
    return characteristic;
  }
}

function advertisementOf(peripheral: Peripheral): BleAdvertisement {
  const name = peripheral.advertisement.localName;
  return {
    id: peripheral.id,
    address: peripheral.address === "" ? peripheral.id : peripheral.address,
    name: name === "" ? undefined : name,
    rssi: peripheral.rssi,
  };
}

/**
 * Creates the {@link BleCentral} backed by `@stoprocent/noble`. The native module loads on the
 * first scan, so creating a central needs no radio and importing this module loads nothing native.
 *
 * A scan fails with {@link TransportError} when the host has no Bluetooth adapter that is powered
 * on, or the process lacks permission to use it.
 */
export function createNobleCentral(): BleCentral {
  const seen = new Map<string, Peripheral>();
  let loaded: Promise<Noble> | undefined;
  let loadedNoble: Noble | undefined;
  const load = (): Promise<Noble> =>
    (loaded ??= import("@stoprocent/noble").then((m) => (loadedNoble = m.default)));

  return {
    async scan(timeoutMs, stopWhen) {
      const noble = await load();
      try {
        await noble.waitForPoweredOnAsync(POWER_ON_TIMEOUT_MS);
      } catch (error) {
        throw new TransportError(`Bluetooth is not available: ${errorText(error)}`);
      }
      const devices = new Map<string, BleAdvertisement>();
      let finish = (): void => undefined;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const onDiscover = (peripheral: Peripheral): void => {
        seen.set(peripheral.id, peripheral);
        const device = advertisementOf(peripheral);
        devices.set(device.id, device);
        if (stopWhen?.(device) === true) finish();
      };
      noble.on("discover", onDiscover);
      const timer = setTimeout(finish, timeoutMs);
      try {
        await noble.startScanningAsync([], false);
        await stopped;
      } finally {
        clearTimeout(timer);
        noble.removeListener("discover", onDiscover);
        await noble.stopScanningAsync();
      }
      return [...devices.values()].sort((a, b) => b.rssi - a.rssi);
    },
    peripheral(device) {
      const peripheral = seen.get(device.id);
      if (peripheral === undefined) {
        throw new TransportError(`Bluetooth LE device ${device.id} was not seen in a scan`);
      }
      return new NoblePeripheral(peripheral);
    },
    close() {
      // Noble keeps its HCI socket and its exit and interrupt listeners for the life of the process, so without this stop the command line never exits after a link was used.
      if (loadedNoble !== undefined) loadedNoble.stop();
    },
  };
}
