import { describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  TransportError,
  TransportTimeout,
  openTransport,
  parseAdapterUrl,
} from "../../src/core/index.js";
import {
  SPP_SERVICE_CLASS_ID,
  WebSerialTransport,
  createWebSerialTransport,
  serialRequestFromParams,
  type SerialLike,
  type SerialPortLike,
  type SerialRequest,
} from "../../src/web/serial.js";
import "../../src/web/index.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** A port whose incoming stream the test drives. close() fails while a stream is still locked, as the real one does. */
class FakePort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  openedWith: { baudRate: number } | undefined;
  closed = false;
  readonly written: Uint8Array[] = [];
  readonly #events = new EventTarget();
  #incoming: ReadableStreamDefaultController<Uint8Array> | undefined;
  openError: Error | undefined;

  async open(options: { baudRate: number }): Promise<void> {
    if (this.openError !== undefined) throw this.openError;
    this.openedWith = options;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#incoming = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(chunk);
      },
    });
    await Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.readable?.locked === true || this.writable?.locked === true) {
      throw new TypeError("a stream is still locked");
    }
    this.closed = true;
    await Promise.resolve();
  }

  addEventListener(type: string, listener: () => void): void {
    this.#events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#events.removeEventListener(type, listener);
  }

  receive(...values: number[]): void {
    this.#incoming?.enqueue(Uint8Array.from(values));
  }

  /** The adapter is unplugged: the stream errors and the port fires `disconnect`. */
  unplug(): void {
    this.#events.dispatchEvent(new Event("disconnect"));
    this.#incoming?.error(new DOMException("The device has been lost.", "NetworkError"));
  }

  endStream(): void {
    this.#incoming?.close();
  }
}

function fakeSerial(
  port: FakePort,
  rejection?: Error,
): { serial: SerialLike; requests: SerialRequest[] } {
  const requests: SerialRequest[] = [];
  return {
    requests,
    serial: {
      requestPort(options) {
        requests.push(options);
        return rejection === undefined ? Promise.resolve(port) : Promise.reject(rejection);
      },
    },
  };
}

async function opened(
  port = new FakePort(),
): Promise<{ transport: WebSerialTransport; port: FakePort }> {
  const transport = new WebSerialTransport("test", { filters: [] }, 38400, fakeSerial(port));
  await transport.open();
  return { transport, port };
}

describe("WebSerialTransport", () => {
  it("opens at the baud rate, returns received bytes and writes bytes", async () => {
    const port = new FakePort();
    const transport = new WebSerialTransport("test", { filters: [] }, 115200, fakeSerial(port));
    await transport.open();
    expect(port.openedWith).toEqual({ baudRate: 115200 });
    port.receive(1, 2);
    expect(await transport.read(100)).toEqual(bytes(1, 2));
    await transport.write(bytes(65, 66));
    expect(port.written).toEqual([bytes(65, 66)]);
    await transport.close();
  });

  it("asks requestPort for the filters it was given", async () => {
    const port = new FakePort();
    const { serial, requests } = fakeSerial(port);
    const request = serialRequestFromParams(new Map([["usbVendorId", "0x0403"]]));
    await new WebSerialTransport("t", request, 38400, { serial }).open();
    expect(requests).toEqual([{ filters: [{ usbVendorId: 0x403 }] }]);
  });

  it("times out when nothing arrives", async () => {
    const { transport } = await opened();
    await expect(transport.read(20)).rejects.toBeInstanceOf(TransportTimeout);
    await transport.close();
  });

  it("rejects a read waiting when the adapter is unplugged mid-read", async () => {
    const { transport, port } = await opened();
    const pending = transport.read(1000);
    port.unplug();
    await expect(pending).rejects.toThrow("disconnected");
    await expect(transport.write(bytes(1))).rejects.toBeInstanceOf(TransportError);
    await transport.close();
    expect(port.closed).toBe(true);
  });

  it("delivers bytes received before a disconnect first", async () => {
    const { transport, port } = await opened();
    port.receive(9);
    await Promise.resolve();
    port.unplug();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await transport.read(10)).toEqual(bytes(9));
    await expect(transport.read(10)).rejects.toThrow("disconnected");
    await transport.close();
  });

  it("reports an ended stream as a failure", async () => {
    const { transport, port } = await opened();
    const pending = transport.read(1000);
    port.endStream();
    await expect(pending).rejects.toThrow("ended");
    await transport.close();
  });

  it("closes while a read is pending: rejects it, releases the locks and closes the port", async () => {
    const { transport, port } = await opened();
    const pending = transport.read(5000);
    const outcome = expect(pending).rejects.toBeInstanceOf(TransportError);
    await transport.close();
    await outcome;
    expect(port.closed).toBe(true);
    expect(port.readable?.locked).toBe(false);
    expect(port.writable?.locked).toBe(false);
    await transport.close();
  });

  it("can be reopened after close", async () => {
    const { transport, port } = await opened();
    await transport.close();
    await transport.open();
    port.receive(3);
    expect(await transport.read(100)).toEqual(bytes(3));
    await transport.close();
  });

  it("refuses writes before open", async () => {
    const transport = new WebSerialTransport(
      "t",
      { filters: [] },
      38400,
      fakeSerial(new FakePort()),
    );
    await expect(transport.write(bytes(1))).rejects.toBeInstanceOf(TransportError);
    await transport.close();
  });

  it("maps no port chosen, permission denial and other request failures", async () => {
    const cases: [Error, string][] = [
      [
        new DOMException("No port selected by the user.", "NotFoundError"),
        "no serial port was chosen",
      ],
      [new DOMException("Must be handling a user gesture.", "SecurityError"), "permission"],
      [new DOMException("blocked", "NotAllowedError"), "permission"],
      [new Error("boom"), "cannot request a serial port: boom"],
    ];
    for (const [rejection, message] of cases) {
      const transport = new WebSerialTransport(
        "t",
        { filters: [] },
        38400,
        fakeSerial(new FakePort(), rejection),
      );
      const failure = transport.open();
      await expect(failure).rejects.toBeInstanceOf(TransportError);
      await expect(failure).rejects.toThrow(message);
    }
  });

  it("maps a port that cannot be opened", async () => {
    const port = new FakePort();
    port.openError = new DOMException("busy", "InvalidStateError");
    const transport = new WebSerialTransport("t", { filters: [] }, 38400, fakeSerial(port));
    await expect(transport.open()).rejects.toThrow("cannot open the serial port");
  });

  it("explains a browser without Web Serial", async () => {
    const transport = new WebSerialTransport("t", { filters: [] }, 38400, { serial: undefined });
    await expect(transport.open()).rejects.toThrow("Web Serial is not available");
  });
});

describe("serialRequestFromParams and the webserial scheme", () => {
  it("builds filters from parameters", () => {
    expect(serialRequestFromParams(new Map())).toEqual({ filters: [] });
    expect(
      serialRequestFromParams(
        new Map([
          ["usbVendorId", "1027"],
          ["usbProductId", "0x6001"],
        ]),
      ),
    ).toEqual({ filters: [{ usbVendorId: 1027, usbProductId: 0x6001 }] });
    expect(serialRequestFromParams(new Map([["bluetoothServiceClassId", "spp"]]))).toEqual({
      filters: [{ bluetoothServiceClassId: SPP_SERVICE_CLASS_ID }],
    });
    expect(serialRequestFromParams(new Map([["bluetoothServiceClassId", "1101"]]))).toEqual({
      filters: [{ bluetoothServiceClassId: 0x1101 }],
    });
  });

  it("rejects non-numeric ids and baud", () => {
    expect(() => serialRequestFromParams(new Map([["usbVendorId", "ftdi"]]))).toThrow(
      AdapterUrlError,
    );
    expect(() => createWebSerialTransport(parseAdapterUrl("webserial://x?baud=fast"))).toThrow(
      AdapterUrlError,
    );
  });

  it("is registered by the web entry point", () => {
    expect(openTransport("webserial://vLinker?baud=9600")).toBeInstanceOf(WebSerialTransport);
  });
});
