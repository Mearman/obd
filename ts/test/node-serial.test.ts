import { SerialPortMock } from "serialport";
import { describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  TransportError,
  TransportTimeout,
  parseAdapterUrl,
} from "../src/core/index.js";
import {
  DEFAULT_BAUD,
  SerialTransport,
  parseBaud,
  serialTransportFor,
  type SerialPortFactory,
} from "../src/node/serial.js";

let counter = 0;

/** Registers a mock device and returns its path and a factory that builds ports on the mock binding. */
async function mockDevice(echo = true): Promise<{
  path: string;
  factory: SerialPortFactory;
  ports: SerialPortMock[];
  bauds: number[];
}> {
  counter += 1;
  const path = `/dev/mock-elm-${String(counter)}`;
  SerialPortMock.binding.createPort(path, { echo, record: true });
  const ports: SerialPortMock[] = [];
  const bauds: number[] = [];
  const factory: SerialPortFactory = (devicePath, baudRate) => {
    const port = new SerialPortMock({ path: devicePath, baudRate, autoOpen: false });
    ports.push(port);
    bauds.push(baudRate);
    return port;
  };
  await Promise.resolve();
  return { path, factory, ports, bauds };
}

describe("SerialTransport", () => {
  it("writes to the device and reads what comes back", async () => {
    const { path, factory, bauds } = await mockDevice();
    const transport = new SerialTransport(path, 38_400, factory);
    await transport.open();
    try {
      await transport.write(new TextEncoder().encode("ATZ\r"));
      expect(new TextDecoder().decode(await transport.read(1000))).toBe("ATZ\r");
      await expect(transport.read(30)).rejects.toThrow(TransportTimeout);
      expect(bauds).toEqual([38_400]);
    } finally {
      await transport.close();
    }
  });

  it("returns the first byte together with everything else already received", async () => {
    const { path, factory, ports } = await mockDevice(false);
    const transport = new SerialTransport(path, DEFAULT_BAUD, factory);
    await transport.open();
    try {
      const mock = ports[0]?.port;
      mock?.emitData(Buffer.of(1, 2));
      mock?.emitData(Buffer.of(3));
      const data = await transport.read(1000);
      const more = data.length < 3 ? await transport.read(1000) : new Uint8Array(0);
      expect([...data, ...more]).toEqual([1, 2, 3]);
    } finally {
      await transport.close();
    }
  });

  it("wraps a failure to open the device", async () => {
    const { factory } = await mockDevice();
    const transport = new SerialTransport("/dev/mock-missing", DEFAULT_BAUD, factory);
    await expect(transport.open()).rejects.toThrow(/cannot open \/dev\/mock-missing/);
    await expect(transport.open()).rejects.toThrow(TransportError);
  });

  it("fails reads and writes when not open and tolerates a double close", async () => {
    const { path, factory } = await mockDevice();
    const transport = new SerialTransport(path, DEFAULT_BAUD, factory);
    await expect(transport.read(10)).rejects.toThrow(/not open/);
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
    await transport.close();
    await transport.open();
    await expect(transport.open()).rejects.toThrow(/already open/);
    await transport.close();
    await transport.close();
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
  });

  it("reports a device that disappears", async () => {
    const { path, factory, ports } = await mockDevice(false);
    const transport = new SerialTransport(path, DEFAULT_BAUD, factory);
    await transport.open();
    const lost = transport.read(1000);
    ports[0]?.port?.emitData(Buffer.of(9));
    expect(await lost).toEqual(Uint8Array.of(9));
    const next = transport.read(1000);
    ports[0]?.destroy();
    await expect(next).rejects.toThrow(/serial link closed unexpectedly/);
    await transport.close();
  });
});

describe("the baud parameter", () => {
  it("defaults to 115200 and reads baud from the URL", () => {
    expect(parseBaud(parseAdapterUrl("serial:///dev/tty.usbserial-1"))).toBe(115_200);
    expect(parseBaud(parseAdapterUrl("slcan:///dev/ttyACM0?baud=1000000"))).toBe(1_000_000);
  });

  it.each(["abc", "0", "-5", "9600.5"])("refuses baud=%s", (baud) => {
    expect(() => serialTransportFor(parseAdapterUrl(`serial:///dev/x?baud=${baud}`))).toThrow(
      AdapterUrlError,
    );
  });
});
