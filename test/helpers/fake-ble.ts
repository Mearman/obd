/**
 * A fake Bluetooth LE radio and peripheral for the BLE tests. Nothing here uses a radio: the
 * peripheral records writes and delivers notifications the test chooses.
 */

import {
  type BleAdvertisement,
  type BleCentral,
  type BlePeripheral,
  type GattCharacteristic,
} from "../../src/node/ble.js";

/** A scripted peripheral. */
export class FakePeripheral implements BlePeripheral {
  connected = false;
  connectError: Error | undefined;
  /** Every write: the characteristic, the bytes and whether a response was requested. */
  readonly writes: { characteristic: string; data: Uint8Array; withResponse: boolean }[] = [];
  readonly subscribed: string[] = [];
  disconnects = 0;
  private notify: ((data: Uint8Array) => void) | undefined;
  private readonly disconnectListeners: (() => void)[] = [];

  constructor(readonly gatt: readonly GattCharacteristic[]) {}

  connect(): Promise<void> {
    if (this.connectError !== undefined) return Promise.reject(this.connectError);
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    if (this.connected) this.drop();
    return Promise.resolve();
  }

  characteristics(): Promise<readonly GattCharacteristic[]> {
    return Promise.resolve(this.gatt);
  }

  subscribe(characteristic: string, onData: (data: Uint8Array) => void): Promise<void> {
    this.subscribed.push(characteristic);
    this.notify = onData;
    return Promise.resolve();
  }

  write(characteristic: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    this.writes.push({ characteristic, data, withResponse });
    return Promise.resolve();
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  /** Delivers a notification as the device would. */
  emit(data: Uint8Array): void {
    this.notify?.(data);
  }

  /** Ends the connection from the device's side, or from ours when called by {@link disconnect}. */
  drop(): void {
    this.connected = false;
    this.disconnects += 1;
    for (const listener of this.disconnectListeners) listener();
  }
}

/** A radio that sees a fixed set of devices. */
export class FakeCentral implements BleCentral {
  readonly scans: number[] = [];
  closes = 0;

  constructor(
    private readonly devices: readonly { device: BleAdvertisement; peripheral: FakePeripheral }[],
  ) {}

  scan(
    timeoutMs: number,
    stopWhen?: (device: BleAdvertisement) => boolean,
  ): Promise<readonly BleAdvertisement[]> {
    this.scans.push(timeoutMs);
    const seen: BleAdvertisement[] = [];
    for (const { device } of this.devices) {
      seen.push(device);
      if (stopWhen?.(device) === true) break;
    }
    return Promise.resolve(seen);
  }

  peripheral(device: BleAdvertisement): BlePeripheral {
    const entry = this.devices.find((candidate) => candidate.device.id === device.id);
    if (entry === undefined) throw new Error(`unknown device ${device.id}`);
    return entry.peripheral;
  }

  close(): void {
    this.closes += 1;
  }
}
