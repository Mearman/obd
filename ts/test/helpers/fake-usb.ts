/** A hand-written fake of the WebUSB surface, behaving as a gs_usb adapter does. */

import { GS_HOST_FRAME_ECHO_ID_RX } from "../../src/core/index.js";
import type {
  UsbConfigurationLike,
  UsbDeviceLike,
  UsbEnvironment,
  UsbInResultLike,
  UsbLike,
  UsbOutResultLike,
  UsbRequest,
  UsbSetupLike,
} from "../../src/web/usb.js";

export const le32 = (...words: number[]): Uint8Array<ArrayBuffer> => {
  const data = new Uint8Array(words.length * 4);
  const view = new DataView(data.buffer);
  words.forEach((word, index) => {
    view.setUint32(index * 4, word, true);
  });
  return data;
};

/** A DOM exception name the real API would use, on a plain `Error`. */
export function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Bit-timing constants of a 48 MHz controller with listen-only support, as a device would send them. */
export const CONSTANTS_REPLY = le32(1, 48_000_000, 1, 16, 1, 8, 4, 1, 1024, 1);

export interface ControlRecord {
  readonly direction: "in" | "out";
  readonly setup: UsbSetupLike;
  readonly data: Uint8Array | undefined;
}

export interface FakeUsbOptions {
  /** Reply to the bit-timing-constants request. */
  constantsReply?: Uint8Array<ArrayBuffer>;
  /** Highest channel index in the device configuration reply. */
  highestChannel?: number;
  /** Whether the device exposes a bulk endpoint pair. */
  bulkEndpoints?: boolean;
  /** Requests the device refuses with a stall. */
  stalledRequests?: ReadonlySet<number>;
}

const view = (data: Uint8Array): DataView =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);

/** One gs_usb adapter on a fake bus. */
export class FakeUsbDevice implements UsbDeviceLike {
  configuration: UsbConfigurationLike | null = null;
  readonly log: string[] = [];
  readonly controls: ControlRecord[] = [];
  readonly transmitted: Uint8Array[] = [];
  opened = false;
  closed = false;
  claimed: number | undefined;
  released: number | undefined;
  /** Called with each host frame the host sends, to let a test play the bus. */
  onTransmit: ((packet: Uint8Array) => void) | undefined;

  readonly #options: FakeUsbOptions;
  readonly #incoming: Uint8Array[] = [];
  #pending:
    { resolve: (result: UsbInResultLike) => void; reject: (error: Error) => void } | undefined;
  #gone = false;
  #nextInStatus: "ok" | "stall" | "babble" = "ok";
  clearedHalts = 0;

  constructor(options: FakeUsbOptions = {}) {
    this.#options = options;
  }

  open(): Promise<void> {
    this.log.push("open");
    this.opened = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.log.push("close");
    this.closed = true;
    this.#pending?.reject(namedError("AbortError", "the transfer was cancelled"));
    this.#pending = undefined;
    return Promise.resolve();
  }

  selectConfiguration(value: number): Promise<void> {
    this.log.push(`selectConfiguration ${String(value)}`);
    const endpoints =
      this.#options.bulkEndpoints === false
        ? []
        : ([
            { endpointNumber: 1, direction: "in", type: "bulk" },
            { endpointNumber: 2, direction: "out", type: "bulk" },
          ] as const);
    this.configuration = {
      configurationValue: value,
      interfaces: [{ interfaceNumber: 0, alternate: { endpoints } }],
    };
    return Promise.resolve();
  }

  claimInterface(interfaceNumber: number): Promise<void> {
    this.log.push(`claimInterface ${String(interfaceNumber)}`);
    this.claimed = interfaceNumber;
    return Promise.resolve();
  }

  releaseInterface(interfaceNumber: number): Promise<void> {
    this.log.push(`releaseInterface ${String(interfaceNumber)}`);
    this.released = interfaceNumber;
    return Promise.resolve();
  }

  controlTransferIn(setup: UsbSetupLike, length: number): Promise<UsbInResultLike> {
    this.#assertPresent();
    this.log.push(`control in ${String(setup.request)}`);
    this.controls.push({ direction: "in", setup, data: undefined });
    if (this.#options.stalledRequests?.has(setup.request) === true) {
      return Promise.resolve({ status: "stall" });
    }
    const reply = this.#reply(setup.request);
    return Promise.resolve({ status: "ok", data: view(reply.slice(0, length)) });
  }

  #reply(request: number): Uint8Array {
    if (request === 5) {
      const config = new Uint8Array(12);
      config[3] = this.#options.highestChannel ?? 0;
      config.set(le32(0x0102, 0x0304), 4);
      return config;
    }
    if (request === 4) return this.#options.constantsReply ?? CONSTANTS_REPLY;
    throw new Error(`the fake adapter has no reply to request ${String(request)}`);
  }

  controlTransferOut(setup: UsbSetupLike, data: Uint8Array): Promise<UsbOutResultLike> {
    this.#assertPresent();
    this.log.push(`control out ${String(setup.request)}`);
    this.controls.push({ direction: "out", setup, data });
    if (this.#options.stalledRequests?.has(setup.request) === true) {
      return Promise.resolve({ status: "stall", bytesWritten: 0 });
    }
    return Promise.resolve({ status: "ok", bytesWritten: data.length });
  }

  clearHalt(): Promise<void> {
    this.clearedHalts += 1;
    return Promise.resolve();
  }

  transferIn(endpointNumber: number): Promise<UsbInResultLike> {
    this.#assertPresent();
    this.log.push(`transfer in ${String(endpointNumber)}`);
    if (this.#nextInStatus !== "ok") {
      const status = this.#nextInStatus;
      this.#nextInStatus = "ok";
      return Promise.resolve({ status });
    }
    const packet = this.#incoming.shift();
    if (packet !== undefined) return Promise.resolve({ status: "ok", data: view(packet) });
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }

  transferOut(endpointNumber: number, data: Uint8Array): Promise<UsbOutResultLike> {
    this.#assertPresent();
    this.log.push(`transfer out ${String(endpointNumber)}`);
    this.transmitted.push(data.slice());
    this.onTransmit?.(data);
    return Promise.resolve({ status: "ok", bytesWritten: data.length });
  }

  #assertPresent(): void {
    if (this.#gone) throw namedError("NotFoundError", "the device was disconnected");
  }

  /** Makes the next bulk-in transfer end with `status`. */
  failNextTransferIn(status: "stall" | "babble"): void {
    this.#nextInStatus = status;
    this.#wake();
  }

  #wake(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    void this.transferIn(1).then(pending.resolve, pending.reject);
  }

  /** Delivers one bulk-in packet to the host. */
  deliver(packet: Uint8Array): void {
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      pending.resolve({ status: "ok", data: view(packet) });
    } else this.#incoming.push(packet);
  }

  /** Delivers a frame received from the bus. */
  deliverFrame(canId: number, data: readonly number[], channel = 0, extended = false): void {
    const packet = new Uint8Array(20);
    const fields = new DataView(packet.buffer);
    fields.setUint32(0, GS_HOST_FRAME_ECHO_ID_RX, true);
    fields.setUint32(4, (canId | (extended ? 0x80000000 : 0)) >>> 0, true);
    packet[8] = data.length;
    packet[9] = channel;
    packet.set(data, 12);
    this.deliver(packet);
  }

  /** Marks the device as unplugged: pending and later transfers fail as the browser's do. */
  unplug(): void {
    this.#gone = true;
    this.#pending?.reject(namedError("NotFoundError", "the device was disconnected"));
    this.#pending = undefined;
  }
}

/** A `navigator.usb` that offers one device, and records what the picker was asked for. */
export class FakeUsb implements UsbLike {
  readonly requests: UsbRequest[] = [];
  readonly #listeners = new Set<(event: Event) => void>();
  /** Set to make the picker fail, as when the user dismisses it. */
  requestError: Error | undefined;

  constructor(readonly device: FakeUsbDevice) {}

  requestDevice(options: UsbRequest): Promise<UsbDeviceLike> {
    this.requests.push(options);
    if (this.requestError !== undefined) return Promise.reject(this.requestError);
    return Promise.resolve(this.device);
  }

  addEventListener(_type: "disconnect", listener: (event: Event) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "disconnect", listener: (event: Event) => void): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Fires a `disconnect` event for `device`, as the browser does when it is unplugged. */
  fireDisconnect(device: unknown): void {
    const event = Object.assign(new Event("disconnect"), { device });
    for (const listener of [...this.#listeners]) listener(event);
  }

  get environment(): UsbEnvironment {
    return { usb: this };
  }
}
