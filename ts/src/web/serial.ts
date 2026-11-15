import {
  AdapterUrlError,
  TransportError,
  type AdapterAddress,
  type Transport,
} from "../core/transport.js";
import { ReadQueue } from "./read-queue.js";

/** The baud rate used when the adapter URL gives none. Bluetooth SPP adapters ignore it. */
export const DEFAULT_SERIAL_BAUD = 38400;

/** The Bluetooth service class id of the Serial Port Profile, for the `spp` shorthand. */
export const SPP_SERVICE_CLASS_ID = "00001101-0000-1000-8000-00805f9b34fb";

/** The part of a Web Serial port that the transport uses. A real `SerialPort` satisfies it. */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What `requestPort` is asked for: the picker's filters. */
export interface SerialRequest {
  filters: {
    usbVendorId?: number;
    usbProductId?: number;
    bluetoothServiceClassId?: number | string;
  }[];
}

/** The part of `navigator.serial` that the transport uses. */
export interface SerialLike {
  requestPort(options: SerialRequest): Promise<SerialPortLike>;
}

/** The environment a Web Serial transport reads its `Serial` object from. */
export interface SerialEnvironment {
  /** `navigator.serial`, or undefined where the browser has no Web Serial. */
  readonly serial: SerialLike | undefined;
}

/** The environment of the running page. */
export function browserSerialEnvironment(): SerialEnvironment {
  if (typeof navigator === "undefined" || !("serial" in navigator)) return { serial: undefined };
  const serial: SerialLike = navigator.serial;
  return { serial };
}

function parseInteger(name: string, text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterUrlError(
      `${name} must be a non-negative integer (decimal or 0x hex): ${text}`,
    );
  }
  return value;
}

/**
 * The picker filter an adapter URL asks for. Parameters: `usbVendorId` and `usbProductId` (decimal
 * or `0x` hex) and `bluetoothServiceClassId` (a UUID, a 16-bit hex id, or `spp` for the Serial Port
 * Profile). With none, the picker lists every port.
 *
 * @throws AdapterUrlError for a value that is not a number or id.
 */
export function serialRequestFromParams(params: ReadonlyMap<string, string>): SerialRequest {
  const filter: SerialRequest["filters"][number] = {};
  const vendor = params.get("usbVendorId");
  const product = params.get("usbProductId");
  const bluetooth = params.get("bluetoothServiceClassId");
  if (vendor !== undefined) filter.usbVendorId = parseInteger("usbVendorId", vendor);
  if (product !== undefined) filter.usbProductId = parseInteger("usbProductId", product);
  if (bluetooth !== undefined) {
    filter.bluetoothServiceClassId =
      bluetooth.toLowerCase() === "spp"
        ? SPP_SERVICE_CLASS_ID
        : /^(0x)?[0-9a-f]{4}$/i.test(bluetooth)
          ? parseInteger(
              "bluetoothServiceClassId",
              bluetooth.startsWith("0x") ? bluetooth : `0x${bluetooth}`,
            )
          : bluetooth;
  }
  return { filters: Object.keys(filter).length === 0 ? [] : [filter] };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An ELM327 adapter reached over Web Serial: a USB serial adapter or a paired classic Bluetooth
 * SPP adapter.
 *
 * {@link open} shows the browser's port picker, so it must be called straight from a user gesture
 * (a click handler) with nothing awaited before it.
 */
export class WebSerialTransport implements Transport {
  readonly #label: string;
  readonly #request: SerialRequest;
  readonly #baud: number;
  readonly #environment: SerialEnvironment;
  #queue = new ReadQueue();
  #port: SerialPortLike | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #loop: Promise<void> = Promise.resolve();
  #closing = false;
  #disconnected = false;
  #onDisconnect: (() => void) | undefined;

  /**
   * @param label Free name for the adapter, used in messages.
   * @param request Picker filters, usually from {@link serialRequestFromParams}.
   * @param baud Baud rate to open the port at.
   * @param environment Where to find `navigator.serial`.
   */
  constructor(
    label: string,
    request: SerialRequest,
    baud: number = DEFAULT_SERIAL_BAUD,
    environment: SerialEnvironment = browserSerialEnvironment(),
  ) {
    this.#label = label;
    this.#request = request;
    this.#baud = baud;
    this.#environment = environment;
  }

  /**
   * Shows the port picker, opens the chosen port and starts reading it.
   *
   * @throws TransportError when Web Serial is missing, permission is denied, no port is chosen or
   * the port cannot be opened.
   */
  async open(): Promise<void> {
    if (this.#port !== undefined) return;
    const serial = this.#environment.serial;
    if (serial === undefined) {
      throw new TransportError(
        "Web Serial is not available in this browser (it needs Chrome or Edge over HTTPS or localhost)",
      );
    }
    let port: SerialPortLike;
    try {
      port = await serial.requestPort(this.#request);
    } catch (error) {
      const name = errorName(error);
      if (name === "NotFoundError") {
        throw new TransportError(`no serial port was chosen for ${this.#label}`, { cause: error });
      }
      if (name === "SecurityError" || name === "NotAllowedError") {
        throw new TransportError(
          `permission to use a serial port was denied (it must be requested from a click or tap): ${errorText(error)}`,
          { cause: error },
        );
      }
      throw new TransportError(`cannot request a serial port: ${errorText(error)}`, {
        cause: error,
      });
    }
    try {
      await port.open({ baudRate: this.#baud });
    } catch (error) {
      throw new TransportError(
        `cannot open the serial port for ${this.#label}: ${errorText(error)}`,
        { cause: error },
      );
    }
    const readable = port.readable;
    const writable = port.writable;
    if (readable === null || writable === null) {
      await port.close().catch(() => undefined);
      throw new TransportError("the serial port opened without a readable and writable stream");
    }
    this.#queue = new ReadQueue();
    this.#closing = false;
    this.#disconnected = false;
    this.#port = port;
    this.#reader = readable.getReader();
    this.#writer = writable.getWriter();
    this.#onDisconnect = () => {
      this.#disconnected = true;
      this.#queue.fail(new TransportError(`the serial adapter ${this.#label} was disconnected`));
    };
    port.addEventListener("disconnect", this.#onDisconnect);
    this.#loop = this.#readLoop(this.#reader);
  }

  async #readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#queue.push(value);
      }
      if (!this.#closing) {
        this.#queue.fail(
          new TransportError(
            this.#disconnected
              ? `the serial adapter ${this.#label} was disconnected`
              : `the serial port for ${this.#label} ended`,
          ),
        );
      }
    } catch (error) {
      if (!this.#closing) {
        this.#queue.fail(
          new TransportError(
            this.#disconnected
              ? `the serial adapter ${this.#label} was disconnected`
              : `reading the serial port failed: ${errorText(error)}`,
            { cause: error },
          ),
        );
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Whether the port's `disconnect` event has fired, read afresh after every await. */
  #wasDisconnected(): boolean {
    return this.#disconnected;
  }

  /** Stops reading, releases the stream locks and closes the port. Safe to call repeatedly. */
  async close(): Promise<void> {
    const port = this.#port;
    if (port === undefined) return;
    this.#port = undefined;
    this.#closing = true;
    this.#queue.close();
    if (this.#onDisconnect !== undefined)
      port.removeEventListener("disconnect", this.#onDisconnect);
    this.#onDisconnect = undefined;
    await this.#reader?.cancel().catch(() => undefined);
    await this.#loop;
    this.#writer?.releaseLock();
    this.#writer = undefined;
    this.#reader = undefined;
    await port.close().catch(() => undefined);
  }

  /**
   * Sends the bytes to the port.
   *
   * @throws TransportError if the port is not open or the write fails.
   */
  async write(data: Uint8Array): Promise<void> {
    const writer = this.#writer;
    if (writer === undefined) throw new TransportError("the serial link is not open");
    if (this.#wasDisconnected()) {
      throw new TransportError(`the serial adapter ${this.#label} was disconnected`);
    }
    try {
      await writer.write(data);
    } catch (error) {
      throw new TransportError(
        this.#wasDisconnected()
          ? `the serial adapter ${this.#label} was disconnected`
          : `writing to the serial port failed: ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  /** Returns the next bytes received, at least one; see {@link Transport.read}. */
  read(timeoutMs: number): Promise<Uint8Array> {
    return this.#queue.read(timeoutMs);
  }
}

/**
 * Builds the `webserial` transport for an adapter URL. The target is only a label; `baud` sets the
 * baud rate and the picker filters come from {@link serialRequestFromParams}.
 *
 * @throws AdapterUrlError for an invalid `baud` or filter parameter.
 */
export function createWebSerialTransport(
  address: AdapterAddress,
  environment: SerialEnvironment = browserSerialEnvironment(),
): Transport {
  const baud = address.params.get("baud");
  return new WebSerialTransport(
    address.target,
    serialRequestFromParams(address.params),
    baud === undefined ? DEFAULT_SERIAL_BAUD : parseInteger("baud", baud),
    environment,
  );
}
