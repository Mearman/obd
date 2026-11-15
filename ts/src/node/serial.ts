/** Serial link, for USB adapters and classic Bluetooth adapters paired as a serial port. */

import type { Duplex } from "node:stream";
import {
  AdapterUrlError,
  TransportError,
  type AdapterAddress,
  type Transport,
} from "../core/transport.js";
import { Inbox, asBytes, errorText } from "./inbox.js";

/** The baud rate used when an adapter URL gives no `baud` parameter. */
export const DEFAULT_BAUD = 115_200;

/**
 * The part of a `serialport` port this transport uses: a byte stream that is opened and closed
 * explicitly. `SerialPort` and `SerialPortMock` both satisfy it.
 */
export interface SerialPortLike extends Duplex {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
}

/** Builds an unopened port for a device path at a baud rate. */
export type SerialPortFactory = (
  path: string,
  baudRate: number,
) => SerialPortLike | Promise<SerialPortLike>;

/** Builds a real `serialport` port. The native module loads on first use, not on import. */
export const openSystemSerialPort: SerialPortFactory = async (path, baudRate) => {
  const { SerialPort } = await import("serialport");
  return new SerialPort({ path, baudRate, autoOpen: false });
};

/**
 * Reads the `baud` parameter of a serial or SLCAN adapter address.
 *
 * @returns {@link DEFAULT_BAUD} when absent.
 * @throws AdapterUrlError when the value is not a positive whole number.
 */
export function parseBaud(address: AdapterAddress): number {
  const text = address.params.get("baud");
  if (text === undefined) return DEFAULT_BAUD;
  const baud = /^\d+$/.test(text) ? Number(text) : 0;
  if (baud <= 0) {
    throw new AdapterUrlError(`baud must be a positive whole number, got ${JSON.stringify(text)}`);
  }
  return baud;
}

/** An ELM327 adapter on a serial device such as `/dev/tty.usbserial-1`. */
export class SerialTransport implements Transport {
  private port: SerialPortLike | undefined;
  private closing = false;
  private readonly inbox = new Inbox();

  /**
   * @param device The serial device path.
   * @param baud The baud rate.
   * @param openPort Builds the port; defaults to a real `serialport` port.
   */
  constructor(
    private readonly device: string,
    private readonly baud: number,
    private readonly openPort: SerialPortFactory = openSystemSerialPort,
  ) {}

  /** @throws TransportError if the device cannot be opened or the link is already open. */
  async open(): Promise<void> {
    if (this.port !== undefined) throw new TransportError("serial link is already open");
    let port: SerialPortLike;
    try {
      port = await this.openPort(this.device, this.baud);
      await new Promise<void>((resolve, reject) => {
        port.open((error) => {
          if (error === null) resolve();
          else reject(error);
        });
      });
    } catch (error) {
      throw new TransportError(`cannot open ${this.device}: ${errorText(error)}`);
    }
    this.inbox.reset();
    this.closing = false;
    port.on("data", (chunk: unknown) => {
      this.inbox.push(asBytes(chunk));
    });
    port.on("error", (error: Error) => {
      this.inbox.fail(new TransportError(`serial link failed: ${error.message}`));
    });
    port.on("close", () => {
      if (!this.closing) this.inbox.fail(new TransportError("serial link closed unexpectedly"));
    });
    this.port = port;
  }

  async close(): Promise<void> {
    const port = this.port;
    if (port === undefined) return;
    this.port = undefined;
    this.closing = true;
    if (!port.isOpen) return;
    await new Promise<void>((resolve, reject) => {
      port.close((error) => {
        if (error === null) resolve();
        else reject(new TransportError(`cannot close ${this.device}: ${error.message}`));
      });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (port === undefined) throw new TransportError("serial link is not open");
    await new Promise<void>((resolve, reject) => {
      port.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new TransportError(`serial write failed: ${error.message}`));
      });
    });
  }

  /**
   * Waits for the first byte, then returns it with everything else already received.
   *
   * @throws TransportTimeout when nothing arrives within `timeoutMs`.
   * @throws TransportError when the link is not open or has failed.
   */
  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.port === undefined)
      return Promise.reject(new TransportError("serial link is not open"));
    return this.inbox.read(timeoutMs);
  }
}

/** Builds a {@link SerialTransport} for a `serial://` address. */
export function serialTransportFor(address: AdapterAddress): SerialTransport {
  return new SerialTransport(address.target, parseBaud(address));
}
