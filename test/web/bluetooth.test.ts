import { describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  TransportError,
  TransportTimeout,
  openTransport,
  parseAdapterUrl,
} from "../../src/core/index.js";
import {
  DEFAULT_OPTIONAL_SERVICES,
  WebBluetoothTransport,
  createWebBluetoothTransport,
  type BluetoothLike,
  type CharacteristicLike,
  type DeviceLike,
  type DeviceRequest,
  type GattServerLike,
  type ServiceLike,
  type WebBluetoothOptions,
} from "../../src/web/bluetooth.js";
import "../../src/web/index.js";

const base = "-0000-1000-8000-00805f9b34fb";
const svc = (short: string): string => `0000${short}${base}`;
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

class FakeCharacteristic implements CharacteristicLike {
  value: DataView | undefined;
  notifying = false;
  readonly writes: { data: Uint8Array; withResponse: boolean }[] = [];
  readonly #events = new EventTarget();
  writeError: Error | undefined;

  constructor(
    readonly uuid: string,
    readonly properties: CharacteristicLike["properties"],
  ) {}

  startNotifications(): Promise<unknown> {
    this.notifying = true;
    return Promise.resolve(this);
  }

  stopNotifications(): Promise<unknown> {
    this.notifying = false;
    return Promise.resolve(this);
  }

  #record(value: BufferSource, withResponse: boolean): Promise<void> {
    if (this.writeError !== undefined) return Promise.reject(this.writeError);
    const data = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : new Uint8Array(value.slice(0));
    this.writes.push({ data, withResponse });
    return Promise.resolve();
  }

  writeValueWithResponse(value: BufferSource): Promise<void> {
    return this.#record(value, true);
  }

  writeValueWithoutResponse(value: BufferSource): Promise<void> {
    return this.#record(value, false);
  }

  addEventListener(type: string, listener: () => void): void {
    this.#events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#events.removeEventListener(type, listener);
  }

  notify(...values: number[]): void {
    this.value = new DataView(Uint8Array.from(values).buffer);
    this.#events.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeGatt implements GattServerLike {
  connected = false;
  disconnectCalls = 0;
  connectError: Error | undefined;

  constructor(readonly services: ServiceLike[]) {}

  connect(): Promise<GattServerLike> {
    if (this.connectError !== undefined) return Promise.reject(this.connectError);
    this.connected = true;
    return Promise.resolve(this);
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  getPrimaryServices(): Promise<ServiceLike[]> {
    return Promise.resolve(this.services);
  }
}

class FakeDevice implements DeviceLike {
  readonly #events = new EventTarget();
  readonly gatt: FakeGatt;

  constructor(
    readonly name: string,
    services: ServiceLike[],
  ) {
    this.gatt = new FakeGatt(services);
  }

  get disconnectCalls(): number {
    return this.gatt.disconnectCalls;
  }

  set connectError(error: Error | undefined) {
    this.gatt.connectError = error;
  }

  addEventListener(type: string, listener: () => void): void {
    this.#events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#events.removeEventListener(type, listener);
  }

  /** The adapter drops the link. */
  drop(): void {
    this.gatt.connected = false;
    this.#events.dispatchEvent(new Event("gattserverdisconnected"));
  }
}

const none = { notify: false, indicate: false, write: false, writeWithoutResponse: false };

function makeAdapter(): {
  device: FakeDevice;
  notify: FakeCharacteristic;
  write: FakeCharacteristic;
} {
  const generic = new FakeCharacteristic(svc("2a00"), { ...none, notify: true, write: true });
  const notify = new FakeCharacteristic(svc("ffe1"), { ...none, notify: true });
  const write = new FakeCharacteristic(svc("ffe2"), { ...none, write: true });
  const device = new FakeDevice("vLinker FD", [
    { uuid: svc("1800"), getCharacteristics: () => Promise.resolve([generic]) },
    { uuid: svc("ffe0"), getCharacteristics: () => Promise.resolve([notify, write]) },
  ]);
  return { device, notify, write };
}

function fakeBluetooth(device: FakeDevice | Error): {
  bluetooth: BluetoothLike;
  requests: DeviceRequest[];
} {
  const requests: DeviceRequest[] = [];
  return {
    requests,
    bluetooth: {
      requestDevice(options) {
        requests.push(options);
        return device instanceof Error ? Promise.reject(device) : Promise.resolve(device);
      },
    },
  };
}

const options: WebBluetoothOptions = { namePrefix: "vLinker" };

async function opened(adapter = makeAdapter(), configuration = options) {
  const { bluetooth, requests } = fakeBluetooth(adapter.device);
  const transport = new WebBluetoothTransport(configuration, { bluetooth });
  await transport.open();
  return { transport, requests, ...adapter };
}

describe("WebBluetoothTransport", () => {
  it("requests the device by name prefix declaring services, and picks the channel", async () => {
    const { transport, requests, notify, write } = await opened();
    expect(requests).toEqual([
      { filters: [{ namePrefix: "vLinker" }], optionalServices: [...DEFAULT_OPTIONAL_SERVICES] },
    ]);
    expect(notify.notifying).toBe(true);
    notify.notify(1, 2, 3);
    expect(await transport.read(100)).toEqual(bytes(1, 2, 3));
    await transport.write(bytes(65));
    expect(write.writes).toEqual([{ data: bytes(65), withResponse: true }]);
    await transport.close();
  });

  it("declares a chosen service and lists all devices when asked", async () => {
    const { requests } = await opened(makeAdapter(), {
      namePrefix: "x",
      acceptAllDevices: true,
      services: ["18f0"],
      channel: { service: "ffe0" },
    });
    expect(requests).toEqual([
      { acceptAllDevices: true, optionalServices: [svc("18f0"), svc("ffe0")] },
    ]);
  });

  it("splits writes to the write size and uses write without response when offered", async () => {
    const adapter = makeAdapter();
    const { transport, write } = await opened(adapter);
    await transport.write(Uint8Array.from({ length: 45 }, (_, index) => index));
    expect(write.writes.map((w) => w.data.length)).toEqual([20, 20, 5]);
    expect(write.writes.flatMap((w) => [...w.data])).toEqual(
      Array.from({ length: 45 }, (_, i) => i),
    );
    await transport.close();

    const second = makeAdapter();
    const small = await opened(second, { namePrefix: "v", writeSize: 8 });
    await small.transport.write(new Uint8Array(17));
    expect(small.write.writes.map((w) => w.data.length)).toEqual([8, 8, 1]);
    await small.transport.close();
  });

  it("writes without response when the characteristic allows it", async () => {
    const notify = new FakeCharacteristic(svc("ffe1"), {
      ...none,
      notify: true,
      writeWithoutResponse: true,
    });
    const device = new FakeDevice("d", [
      { uuid: svc("ffe0"), getCharacteristics: () => Promise.resolve([notify]) },
    ]);
    const { bluetooth } = fakeBluetooth(device);
    const transport = new WebBluetoothTransport(options, { bluetooth });
    await transport.open();
    await transport.write(bytes(1));
    expect(notify.writes).toEqual([{ data: bytes(1), withResponse: false }]);
    await transport.close();
  });

  it("times out when nothing is notified", async () => {
    const { transport } = await opened();
    await expect(transport.read(20)).rejects.toBeInstanceOf(TransportTimeout);
    await transport.close();
  });

  it("rejects a pending read and later writes when the device disconnects", async () => {
    const { transport, device } = await opened();
    const pending = transport.read(1000);
    device.drop();
    await expect(pending).rejects.toThrow("vLinker FD disconnected");
    await expect(transport.write(bytes(1))).rejects.toThrow("disconnected");
    await transport.close();
  });

  it("closes while a read is pending: rejects it, stops notifications and disconnects", async () => {
    const { transport, device, notify } = await opened();
    const pending = transport.read(5000);
    const outcome = expect(pending).rejects.toBeInstanceOf(TransportError);
    await transport.close();
    await outcome;
    expect(notify.notifying).toBe(false);
    expect(device.disconnectCalls).toBe(1);
    notify.notify(1);
    await expect(transport.read(10)).rejects.toBeInstanceOf(TransportError);
    await transport.close();
    expect(device.disconnectCalls).toBe(1);
  });

  it("maps no device chosen, permission denial and other request failures", async () => {
    const cases: [Error, string][] = [
      [new DOMException("User cancelled", "NotFoundError"), "no Bluetooth device was chosen"],
      [new DOMException("gesture", "SecurityError"), "permission"],
      [new DOMException("blocked", "NotAllowedError"), "permission"],
      [new Error("boom"), "cannot request a Bluetooth device: boom"],
    ];
    for (const [rejection, message] of cases) {
      const transport = new WebBluetoothTransport(options, {
        bluetooth: fakeBluetooth(rejection).bluetooth,
      });
      await expect(transport.open()).rejects.toThrow(message);
    }
  });

  it("maps a failed connection and disconnects nothing it never connected", async () => {
    const adapter = makeAdapter();
    adapter.device.connectError = new DOMException("out of range", "NetworkError");
    const transport = new WebBluetoothTransport(options, {
      bluetooth: fakeBluetooth(adapter.device).bluetooth,
    });
    await expect(transport.open()).rejects.toThrow("cannot connect to vLinker FD: out of range");
  });

  it("fails and disconnects when no service has notify and write", async () => {
    const lone = new FakeCharacteristic(svc("fff1"), { ...none, notify: true });
    const device = new FakeDevice("d", [
      { uuid: svc("fff0"), getCharacteristics: () => Promise.resolve([lone]) },
    ]);
    const transport = new WebBluetoothTransport(options, {
      bluetooth: fakeBluetooth(device).bluetooth,
    });
    await expect(transport.open()).rejects.toThrow("notifying and a writable");
    expect(device.disconnectCalls).toBe(1);
  });

  it("explains a browser without Web Bluetooth", async () => {
    const transport = new WebBluetoothTransport(options, { bluetooth: undefined });
    await expect(transport.open()).rejects.toThrow("Web Bluetooth is not available");
  });

  it("refuses writes before open", async () => {
    const transport = new WebBluetoothTransport(options, { bluetooth: undefined });
    await expect(transport.write(bytes(1))).rejects.toBeInstanceOf(TransportError);
  });

  it("maps a failing write", async () => {
    const { transport, write } = await opened();
    write.writeError = new Error("gatt busy");
    await expect(transport.write(bytes(1))).rejects.toThrow("gatt busy");
    await transport.close();
  });
});

describe("the webbluetooth scheme", () => {
  it("is registered by the web entry point", () => {
    expect(openTransport("webbluetooth://vLinker?services=fff0,ffe0&mtu=100")).toBeInstanceOf(
      WebBluetoothTransport,
    );
  });

  it("rejects a bad mtu", () => {
    expect(() => createWebBluetoothTransport(parseAdapterUrl("webbluetooth://x?mtu=0"))).toThrow(
      AdapterUrlError,
    );
    expect(() => createWebBluetoothTransport(parseAdapterUrl("webbluetooth://x?mtu=big"))).toThrow(
      AdapterUrlError,
    );
  });

  it("takes the name prefix, services and channel overrides from the URL", async () => {
    const adapter = makeAdapter();
    const { bluetooth, requests } = fakeBluetooth(adapter.device);
    const transport = createWebBluetoothTransport(
      parseAdapterUrl(
        "webbluetooth://vLinker?services=ffe0&service=ffe0&notify=ffe1&write=ffe2&mtu=10",
      ),
      { bluetooth },
    );
    await transport.open();
    expect(requests[0]).toEqual({
      filters: [{ namePrefix: "vLinker" }],
      optionalServices: [svc("ffe0"), svc("ffe0")],
    });
    await transport.write(new Uint8Array(25));
    expect(adapter.write.writes.map((w) => w.data.length)).toEqual([10, 10, 5]);
    await transport.close();
  });
});
