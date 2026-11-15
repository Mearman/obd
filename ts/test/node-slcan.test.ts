import { SerialPortMock } from "serialport";
import { describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  CanFrame,
  DiagProtocol,
  Elm,
  RawCanTransport,
  SlcanLink,
  TransportError,
  TransportTimeout,
  asciiDecode,
  asciiEncode,
  parseAdapterUrl,
  permit,
} from "../src/core/index.js";
import { SerialTransport, type SerialPortFactory } from "../src/node/serial.js";
import { slcanTransportFor } from "../src/node/slcan.js";

let counter = 0;

/**
 * A serial port that answers as an SLCAN adapter: every command is acknowledged with a carriage
 * return, or a bell when listed in `refuse`, and each frame sent is acknowledged with `z`.
 */
class SlcanAdapterPort extends SerialPortMock {
  readonly commands: string[] = [];
  refuse: ReadonlySet<string> = new Set();
  /** Called with each frame line sent, so a test can play the bus. */
  onFrame: ((line: string) => void) | undefined;

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error: Error | null) => void,
  ): void {
    super._write(chunk, encoding, (error) => {
      callback(error);
      for (const text of asciiDecode(chunk).split("\r").slice(0, -1)) this.#answer(text);
    });
  }

  #binding(): NonNullable<SerialPortMock["port"]> {
    if (this.port === undefined) throw new Error("the mock port is not open");
    return this.port;
  }

  /** Delivers bytes as the adapter would send them. */
  emitData(data: Buffer): void {
    this.#binding().emitData(data);
  }

  #answer(text: string): void {
    this.commands.push(text);
    if (this.refuse.has(text)) this.emitData(Buffer.from("\x07"));
    else if (text.startsWith("t") || text.startsWith("T")) {
      this.emitData(Buffer.from("z\r"));
      this.onFrame?.(text);
    } else this.emitData(Buffer.from("\r"));
  }
}

function adapter(): { path: string; port: () => SlcanAdapterPort; factory: SerialPortFactory } {
  counter += 1;
  const path = `/dev/mock-slcan-${String(counter)}`;
  SerialPortMock.binding.createPort(path, { echo: false, record: true });
  let created: SlcanAdapterPort | undefined;
  const factory: SerialPortFactory = (devicePath, baudRate) => {
    created = new SlcanAdapterPort({ path: devicePath, baudRate, autoOpen: false });
    return created;
  };
  return {
    path,
    port: () => {
      if (created === undefined) throw new Error("the port was never built");
      return created;
    },
    factory,
  };
}

describe("an SLCAN adapter on a serial device", () => {
  it("configures, sends and receives frames over the port", async () => {
    const { path, port, factory } = adapter();
    const link = new SlcanLink(new SerialTransport(path, 115_200, factory));
    await link.open();
    await link.configure(500_000, false);
    expect(port().commands).toEqual(["C", "S6", "O"]);
    await link.send(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)));
    expect(port().commands.at(-1)).toBe("t7E03021092");
    port().emitData(Buffer.from("t7E825092\rT18DAF1100\r"));
    expect(await link.receive(1000)).toEqual(new CanFrame(0x7e8, Uint8Array.of(0x50, 0x92)));
    expect(await link.receive(1000)).toEqual(new CanFrame(0x18daf110, new Uint8Array(0), true));
    await expect(link.receive(30)).rejects.toThrow(TransportTimeout);
    await link.close();
    expect(port().commands.at(-1)).toBe("C");
    expect(port().isOpen).toBe(false);
  });

  it("starts listen-only, and tolerates the adapter refusing to close an already closed channel", async () => {
    const { path, port, factory } = adapter();
    const link = new SlcanLink(new SerialTransport(path, 115_200, factory));
    await link.open();
    port().refuse = new Set(["C"]);
    await link.configure(250_000, true);
    expect(port().commands).toEqual(["C", "S5", "L"]);
    await link.close();
  });

  it("refuses a rate with no SLCAN setting and a command the adapter rejects", async () => {
    const { path, factory } = adapter();
    const link = new SlcanLink(new SerialTransport(path, 115_200, factory));
    await link.open();
    await expect(link.configure(83_333, false)).rejects.toThrow(/no setting/);
    await link.close();

    const refusing = adapter();
    const second = new SlcanLink(new SerialTransport(refusing.path, 115_200, refusing.factory));
    await second.open();
    refusing.port().refuse = new Set(["S6"]);
    await expect(second.configure(500_000, false)).rejects.toThrow(/refused "S6"/);
    await second.close();
  });

  it("fails to open a device that is not there, as a TransportError", async () => {
    const { factory } = adapter();
    const link = new SlcanLink(new SerialTransport("/dev/mock-slcan-missing", 115_200, factory));
    await expect(link.open()).rejects.toThrow(TransportError);
  });
});

describe("slcanTransportFor", () => {
  it("builds an ELM327 look-alike and takes the baud from the URL", async () => {
    const { path, port, factory } = adapter();
    const address = parseAdapterUrl(`slcan://${path}?baud=921600`);
    const transport = slcanTransportFor(address, factory);
    expect(transport).toBeInstanceOf(RawCanTransport);
    await transport.open();
    expect(port().baudRate).toBe(921_600);
    await transport.close();
  });

  it("defaults to 115200 baud and refuses a bad baud", async () => {
    const { path, port, factory } = adapter();
    const transport = slcanTransportFor(parseAdapterUrl(`slcan://${path}`), factory);
    await transport.open();
    expect(port().baudRate).toBe(115_200);
    await transport.close();
    expect(() => slcanTransportFor(parseAdapterUrl(`slcan://${path}?baud=fast`), factory)).toThrow(
      AdapterUrlError,
    );
  });

  it("runs a session over the serial port", async () => {
    const { path, port, factory } = adapter();
    const transport = slcanTransportFor(parseAdapterUrl(`slcan://${path}`), factory);
    await transport.open();
    port().onFrame = (line) => {
      if (line.startsWith("t7E0")) port().emitData(Buffer.from("t7E88025092CCCCCCCCCC\r"));
    };
    const elm = new Elm(transport);
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x7e0, 0x7e8);
    const replies = await elm.request(
      await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x92)),
    );
    expect(replies).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
    expect(port().commands).toContain("t7E08021092CCCCCCCCCC");
    await transport.close();
    expect(asciiEncode(port().commands.at(-1) ?? "")).toEqual(asciiEncode("C"));
  });
});
