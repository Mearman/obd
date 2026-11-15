/**
 * Finding adapters: nearby Bluetooth LE devices, serial ports, and the characteristics of one
 * Bluetooth LE device, so the data channel to put in an adapter URL can be chosen.
 */

import { TransportError } from "../core/transport.js";
import {
  matchesBleTarget,
  type BleAdvertisement,
  type BleCentral,
  type GattCharacteristic,
} from "./ble.js";

/** One serial port the host reports. `description` is never empty. */
export interface SerialPortEntry {
  readonly path: string;
  readonly description: string;
}

/** Lists the serial ports the host reports. */
export type SerialPortLister = () => Promise<readonly SerialPortEntry[]>;

/** Lists the host's serial ports through `serialport`, which loads on first use. */
export const listSystemSerialPorts: SerialPortLister = async () => {
  const { SerialPort } = await import("serialport");
  const ports = await SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    description: port.manufacturer ?? port.pnpId ?? "n/a",
  }));
};

/** Nearby devices and serial ports. */
export interface AdapterListing {
  /** Strongest signal first. */
  readonly bluetooth: readonly BleAdvertisement[];
  /** In path order. */
  readonly serial: readonly SerialPortEntry[];
}

/**
 * Scans for Bluetooth LE devices for `timeoutMs` and lists the serial ports.
 *
 * @throws TransportError if the radio is unavailable.
 */
export async function discoverAdapters(
  central: BleCentral,
  timeoutMs: number,
  listPorts: SerialPortLister = listSystemSerialPorts,
): Promise<AdapterListing> {
  const bluetooth = [...(await central.scan(timeoutMs))].sort((a, b) => b.rssi - a.rssi);
  const serial = [...(await listPorts())].sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { bluetooth, serial };
}

/** The lines `obd-read adapters` prints for a {@link AdapterListing}. */
export function formatAdapterListing(listing: AdapterListing): string[] {
  return [
    "Bluetooth LE devices:",
    ...listing.bluetooth.map(
      (d) => `  ${d.name ?? "(no name)"}  ${d.address}  signal ${String(d.rssi)} dBm`,
    ),
    "Serial ports:",
    ...listing.serial.map((p) => `  ${p.path}  ${p.description}`),
  ];
}

/** A Bluetooth LE device and everything it exposes. */
export interface DeviceInspection {
  readonly device: BleAdvertisement;
  readonly characteristics: readonly GattCharacteristic[];
}

/**
 * Connects to the device `target` names (name part, address or identifier), lists its
 * characteristics and disconnects.
 *
 * @throws TransportError if no such device is seen in `timeoutMs` or it cannot be connected to.
 */
export async function inspectDevice(
  central: BleCentral,
  target: string,
  timeoutMs: number,
): Promise<DeviceInspection> {
  const seen = await central.scan(timeoutMs, (device) => matchesBleTarget(device, target));
  const device = seen.find((candidate) => matchesBleTarget(candidate, target));
  if (device === undefined) {
    throw new TransportError(
      `no Bluetooth LE device matching ${JSON.stringify(target)} seen in ${(timeoutMs / 1000).toFixed(0)} s`,
    );
  }
  const peripheral = central.peripheral(device);
  await peripheral.connect();
  try {
    return { device, characteristics: await peripheral.characteristics() };
  } finally {
    await peripheral.disconnect();
  }
}

/** The lines `obd-read adapters --inspect` prints for a {@link DeviceInspection}. */
export function formatInspection(inspection: DeviceInspection): string[] {
  const lines = [`${inspection.device.name ?? "(no name)"}  ${inspection.device.address}`];
  let service: string | undefined;
  for (const characteristic of inspection.characteristics) {
    if (characteristic.service !== service) {
      service = characteristic.service;
      lines.push(`  service ${service}`);
    }
    lines.push(
      `    characteristic ${characteristic.uuid}  ${characteristic.properties.join(", ")}`,
    );
  }
  return lines;
}
