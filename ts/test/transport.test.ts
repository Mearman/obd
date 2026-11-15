import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  SCHEMES,
  ScriptedTransport,
  TransportError,
  TransportTimeout,
  openTransport,
  parseAdapterUrl,
  registerTransport,
  type Transport,
} from "../src/core/index.js";

const text = new TextEncoder();
const decode = new TextDecoder();

async function readAll(transport: Transport): Promise<string> {
  let out = "";
  for (;;) {
    try {
      out += decode.decode(await transport.read(10));
    } catch (error) {
      if (error instanceof TransportTimeout) return out;
      throw error;
    }
  }
}

describe("parseAdapterUrl", () => {
  it("splits scheme, target and parameters", () => {
    const ble = parseAdapterUrl("ble://vLinker%20FD?service=18f0&notify=2af0");
    expect([ble.scheme, ble.target]).toEqual(["ble", "vLinker FD"]);
    expect(ble.params).toEqual(
      new Map([
        ["service", "18f0"],
        ["notify", "2af0"],
      ]),
    );
    expect(parseAdapterUrl("ble://AA:BB:CC:DD:EE:FF").target).toBe("AA:BB:CC:DD:EE:FF");
    expect(parseAdapterUrl("serial:///dev/tty.usbserial-1").target).toBe("/dev/tty.usbserial-1");
    expect(parseAdapterUrl("tcp://192.168.80.1:35000").target).toBe("192.168.80.1:35000");
    expect(parseAdapterUrl("socketcan://can0").scheme).toBe("socketcan");
    expect(parseAdapterUrl("slcan:///dev/ttyACM0?baud=921600").params.get("baud")).toBe("921600");
  });

  it("takes browser schemes with a free label as the target", () => {
    for (const scheme of ["webserial", "webbluetooth", "webusb"]) {
      const address = parseAdapterUrl(`${scheme}://My%20adapter`);
      expect([address.scheme, address.target]).toEqual([scheme, "My adapter"]);
    }
  });

  it("handles query parameters as the Python parser does", () => {
    const { params } = parseAdapterUrl("serial://x?a=1&a=2&b=&c&d=x+y&e=%7e&&f=%zz");
    expect(params).toEqual(
      new Map([
        ["a", "2"],
        ["d", "x y"],
        ["e", "~"],
        ["f", "%zz"],
      ]),
    );
  });

  it.each(["vLinker", "usb://x", "ble://", "serial://?baud=1", "://x", ""])("refuses %j", (url) => {
    expect(() => parseAdapterUrl(url)).toThrow(AdapterUrlError);
  });

  it("names the schemes it accepts", () => {
    expect(() => parseAdapterUrl("usb://x")).toThrow(`one of ${SCHEMES.join(", ")}://`);
  });
});

describe("openTransport", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("builds the transport the registered factory returns", () => {
    const transport = new ScriptedTransport(() => new Uint8Array(0));
    let seen = "";
    disposers.push(
      registerTransport("tcp", (address) => {
        seen = address.target;
        return transport;
      }),
    );
    expect(openTransport("tcp://192.168.80.1:35000")).toBe(transport);
    expect(seen).toBe("192.168.80.1:35000");
  });

  it("refuses a malformed URL before consulting the registry", () => {
    expect(() => openTransport("tcp://")).toThrow(AdapterUrlError);
  });

  it("says when no entry point serves the scheme", () => {
    expect(() => openTransport("ble://vLinker")).toThrow(TransportError);
    expect(() => openTransport("ble://vLinker")).toThrow("no transport is registered for ble://");
  });

  it("refuses a second factory for a scheme and frees it on dispose", () => {
    const factory = () => new ScriptedTransport(() => new Uint8Array(0));
    const dispose = registerTransport("slcan", factory);
    expect(() => registerTransport("slcan", factory)).toThrow("already registered");
    dispose();
    disposers.push(registerTransport("slcan", factory));
  });

  it("lets a factory reject a target it cannot use", () => {
    disposers.push(
      registerTransport("tcp", (address) => {
        throw new AdapterUrlError(`tcp adapter URL needs host:port, got ${address.target}`);
      }),
    );
    expect(() => openTransport("tcp://hostonly")).toThrow("needs host:port");
  });
});

describe("ScriptedTransport", () => {
  it("replies to writes and splits each reply across reads", async () => {
    const transport = new ScriptedTransport((written) =>
      text.encode(`${decode.decode(written).trim()} OK\r\r>`),
    );
    await transport.open();
    await transport.write(text.encode("ATZ\r"));
    const first = await transport.read(10);
    expect(first.length).toBeLessThan("ATZ OK\r\r>".length);
    expect(decode.decode(first) + (await readAll(transport))).toBe("ATZ OK\r\r>");
    expect(transport.opened).toBe(true);
    expect(transport.written.map((bytes) => decode.decode(bytes))).toEqual(["ATZ\r"]);
  });

  it("times out when nothing is queued", async () => {
    const transport = new ScriptedTransport(() => new Uint8Array(0));
    await expect(transport.read(50)).rejects.toBeInstanceOf(TransportTimeout);
    await expect(transport.read(75)).rejects.toBeInstanceOf(TransportError);
    expect(transport.readTimeouts).toEqual([50, 75]);
  });

  it("always returns at least one byte", async () => {
    const transport = new ScriptedTransport(() => Uint8Array.of(0x3e));
    await transport.write(new Uint8Array(0));
    expect(await transport.read(10)).toEqual(Uint8Array.of(0x3e));
  });

  it("can be closed whether or not it was opened", async () => {
    const transport = new ScriptedTransport(() => new Uint8Array(0));
    await transport.close();
    expect(transport.closed).toBe(true);
  });
});
