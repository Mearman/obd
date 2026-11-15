import {
  AdapterUrlError,
  TransportError,
  type AdapterAddress,
  type Transport,
} from "../core/transport.js";
import {
  MIN_WRITE_SIZE,
  normaliseUuid,
  pickDataChannel,
  type ChannelOverrides,
  type DataChannel,
  type GattCharacteristic,
} from "./gatt.js";
import { ReadQueue } from "./read-queue.js";

/**
 * Services common ELM327 Bluetooth LE adapters expose their data channel on, declared by default
 * because Web Bluetooth only lets a page use services it named when it asked for the device. The
 * `services` parameter replaces the list for an adapter that uses another.
 */
export const DEFAULT_OPTIONAL_SERVICES: readonly string[] = [
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
];

/** The part of a GATT characteristic that the transport uses. A real one satisfies it. */
export interface CharacteristicLike {
  readonly uuid: string;
  readonly properties: {
    readonly notify: boolean;
    readonly indicate: boolean;
    readonly write: boolean;
    readonly writeWithoutResponse: boolean;
  };
  readonly value?: DataView | undefined;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The part of a GATT service that the transport uses. */
export interface ServiceLike {
  readonly uuid: string;
  getCharacteristics(): Promise<CharacteristicLike[]>;
}

/** The part of a GATT server connection that the transport uses. */
export interface GattServerLike {
  readonly connected: boolean;
  connect(): Promise<GattServerLike>;
  disconnect(): void;
  getPrimaryServices(): Promise<ServiceLike[]>;
}

/** The part of a Bluetooth device that the transport uses. */
export interface DeviceLike {
  readonly name?: string | undefined;
  readonly gatt?: GattServerLike | undefined;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What `requestDevice` is asked for. */
export type DeviceRequest =
  | { filters: { namePrefix: string }[]; optionalServices: string[] }
  | { acceptAllDevices: true; optionalServices: string[] };

/** The part of `navigator.bluetooth` that the transport uses. */
export interface BluetoothLike {
  requestDevice(options: DeviceRequest): Promise<DeviceLike>;
}

/** The environment a Web Bluetooth transport reads its `Bluetooth` object from. */
export interface BluetoothEnvironment {
  /** `navigator.bluetooth`, or undefined where the browser has no Web Bluetooth. */
  readonly bluetooth: BluetoothLike | undefined;
}

/** The environment of the running page. */
export function browserBluetoothEnvironment(): BluetoothEnvironment {
  if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
    return { bluetooth: undefined };
  }
  const bluetooth: BluetoothLike = navigator.bluetooth;
  return { bluetooth };
}

/** How a Web Bluetooth transport is configured. */
export interface WebBluetoothOptions {
  /** Device name prefix the picker is limited to. */
  readonly namePrefix: string;
  /** List every nearby device instead of filtering on the name prefix. */
  readonly acceptAllDevices?: boolean;
  /** Services the page declares, as full or short UUIDs. */
  readonly services?: readonly string[];
  /** Constraints on which characteristics carry the data. */
  readonly channel?: ChannelOverrides;
  /** Largest payload of one write, in bytes. */
  readonly writeSize?: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function propertyNames(properties: CharacteristicLike["properties"]): string[] {
  const names: string[] = [];
  if (properties.notify) names.push("notify");
  if (properties.indicate) names.push("indicate");
  if (properties.write) names.push("write");
  if (properties.writeWithoutResponse) names.push("write-without-response");
  return names;
}

/**
 * An ELM327 adapter reached over Web Bluetooth (Bluetooth LE).
 *
 * {@link open} shows the browser's device picker, so it must be called straight from a user
 * gesture (a click handler) with nothing awaited before it. Web Bluetooth does not expose the
 * negotiated MTU, so writes are split to `writeSize` (default {@link MIN_WRITE_SIZE}).
 */
export class WebBluetoothTransport implements Transport {
  readonly #options: WebBluetoothOptions;
  readonly #environment: BluetoothEnvironment;
  #queue = new ReadQueue();
  #device: DeviceLike | undefined;
  #server: GattServerLike | undefined;
  #notify: CharacteristicLike | undefined;
  #write: CharacteristicLike | undefined;
  #channel: DataChannel | undefined;
  #onValue: (() => void) | undefined;
  #onDisconnect: (() => void) | undefined;
  #label = "";

  /**
   * @param options Device filter, declared services and characteristic constraints.
   * @param environment Where to find `navigator.bluetooth`.
   */
  constructor(
    options: WebBluetoothOptions,
    environment: BluetoothEnvironment = browserBluetoothEnvironment(),
  ) {
    this.#options = options;
    this.#environment = environment;
  }

  /**
   * Shows the device picker, connects, picks the data characteristics and subscribes to them.
   *
   * @throws TransportError when Web Bluetooth is missing, permission is denied, no device is
   * chosen, the connection fails or no service has a notify and a write characteristic.
   */
  async open(): Promise<void> {
    if (this.#device !== undefined) return;
    const bluetooth = this.#environment.bluetooth;
    if (bluetooth === undefined) {
      throw new TransportError(
        "Web Bluetooth is not available in this browser (it needs Chrome or Edge over HTTPS or localhost)",
      );
    }
    const declared = (this.#options.services ?? DEFAULT_OPTIONAL_SERVICES).map(normaliseUuid);
    const wanted = this.#options.channel?.service;
    const optionalServices = wanted === undefined ? declared : [...declared, normaliseUuid(wanted)];
    const request: DeviceRequest =
      this.#options.acceptAllDevices === true
        ? { acceptAllDevices: true, optionalServices }
        : { filters: [{ namePrefix: this.#options.namePrefix }], optionalServices };
    let device: DeviceLike;
    try {
      device = await bluetooth.requestDevice(request);
    } catch (error) {
      const name = errorName(error);
      if (name === "NotFoundError") {
        throw new TransportError("no Bluetooth device was chosen", { cause: error });
      }
      if (name === "SecurityError" || name === "NotAllowedError") {
        throw new TransportError(
          `permission to use Bluetooth was denied (it must be requested from a click or tap): ${errorText(error)}`,
          { cause: error },
        );
      }
      throw new TransportError(`cannot request a Bluetooth device: ${errorText(error)}`, {
        cause: error,
      });
    }
    this.#label = device.name ?? "the Bluetooth device";
    this.#queue = new ReadQueue();
    this.#device = device;
    this.#onDisconnect = () => {
      this.#queue.fail(new TransportError(`${this.#label} disconnected`));
    };
    device.addEventListener("gattserverdisconnected", this.#onDisconnect);
    try {
      await this.#connect(device);
    } catch (error) {
      await this.close();
      throw error instanceof TransportError
        ? error
        : new TransportError(`cannot connect to ${this.#label}: ${errorText(error)}`, {
            cause: error,
          });
    }
  }

  async #connect(device: DeviceLike): Promise<void> {
    const gatt = device.gatt;
    if (gatt === undefined) throw new TransportError(`${this.#label} has no GATT server`);
    const server = await gatt.connect();
    this.#server = server;
    const flat: GattCharacteristic[] = [];
    const live = new Map<string, CharacteristicLike>();
    for (const service of await server.getPrimaryServices()) {
      for (const characteristic of await service.getCharacteristics()) {
        flat.push({
          service: service.uuid.toLowerCase(),
          uuid: characteristic.uuid.toLowerCase(),
          properties: propertyNames(characteristic.properties),
        });
        live.set(
          `${service.uuid.toLowerCase()}/${characteristic.uuid.toLowerCase()}`,
          characteristic,
        );
      }
    }
    const channel = pickDataChannel(flat, this.#options.channel);
    const notify = live.get(`${channel.service}/${channel.notify}`);
    const write = live.get(`${channel.service}/${channel.write}`);
    if (notify === undefined || write === undefined) {
      throw new TransportError("the chosen characteristics disappeared from the device");
    }
    this.#channel = channel;
    this.#notify = notify;
    this.#write = write;
    this.#onValue = () => {
      const value = notify.value;
      if (value !== undefined) {
        this.#queue.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
    };
    notify.addEventListener("characteristicvaluechanged", this.#onValue);
    await notify.startNotifications();
  }

  /** Stops notifications and disconnects. Safe to call repeatedly or before opening. */
  async close(): Promise<void> {
    const device = this.#device;
    if (device === undefined) return;
    this.#device = undefined;
    this.#queue.close();
    if (this.#onDisconnect !== undefined) {
      device.removeEventListener("gattserverdisconnected", this.#onDisconnect);
    }
    if (this.#notify !== undefined) {
      if (this.#onValue !== undefined) {
        this.#notify.removeEventListener("characteristicvaluechanged", this.#onValue);
      }
      if (this.#server?.connected === true) {
        await this.#notify.stopNotifications().catch(() => undefined);
      }
    }
    this.#server?.disconnect();
    this.#onDisconnect = undefined;
    this.#onValue = undefined;
    this.#notify = undefined;
    this.#write = undefined;
    this.#channel = undefined;
    this.#server = undefined;
  }

  /**
   * Sends the bytes in chunks of at most the write size.
   *
   * @throws TransportError if the link is not open, has dropped or a write fails.
   */
  async write(data: Uint8Array): Promise<void> {
    const write = this.#write;
    const channel = this.#channel;
    if (write === undefined || channel === undefined) {
      throw new TransportError("the Bluetooth link is not open");
    }
    const size = this.#options.writeSize ?? MIN_WRITE_SIZE;
    for (let start = 0; start < data.length; start += size) {
      if (this.#server?.connected !== true) {
        throw new TransportError(`${this.#label} disconnected`);
      }
      const chunk = data.slice(start, start + size);
      try {
        if (channel.writeWithResponse) await write.writeValueWithResponse(chunk);
        else await write.writeValueWithoutResponse(chunk);
      } catch (error) {
        throw new TransportError(`writing to ${this.#label} failed: ${errorText(error)}`, {
          cause: error,
        });
      }
    }
  }

  /** Returns the next bytes notified, at least one; see {@link Transport.read}. */
  read(timeoutMs: number): Promise<Uint8Array> {
    return this.#queue.read(timeoutMs);
  }
}

function listParam(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * Builds the `webbluetooth` transport for an adapter URL. The target is the device name prefix
 * the picker is limited to. Parameters: `services` (comma-separated UUIDs to declare), `service`,
 * `notify` and `write` (characteristic constraints, as in the Node `ble` scheme), `mtu` (largest
 * write, in bytes) and `all=1` (list every device, ignoring the name prefix).
 *
 * @throws AdapterUrlError for an invalid `mtu`.
 */
export function createWebBluetoothTransport(
  address: AdapterAddress,
  environment: BluetoothEnvironment = browserBluetoothEnvironment(),
): Transport {
  const params = address.params;
  const services = params.get("services");
  const mtu = params.get("mtu");
  const writeSize = mtu === undefined ? undefined : Number(mtu);
  if (writeSize !== undefined && (!Number.isInteger(writeSize) || writeSize < 1)) {
    throw new AdapterUrlError(`mtu must be a positive integer: ${mtu ?? ""}`);
  }
  return new WebBluetoothTransport(
    {
      namePrefix: address.target,
      acceptAllDevices: params.get("all") === "1",
      ...(services === undefined ? {} : { services: listParam(services) }),
      channel: {
        service: params.get("service"),
        notify: params.get("notify"),
        write: params.get("write"),
      },
      ...(writeSize === undefined ? {} : { writeSize }),
    },
    environment,
  );
}
