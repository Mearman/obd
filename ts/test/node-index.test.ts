import { describe, expect, it } from "vitest";
import { AdapterUrlError, TransportError, openTransport } from "../src/core/index.js";
import { RawCanTransport } from "../src/core/index.js";
import { BleTransport, SerialTransport, TcpTransport } from "../src/node/index.js";

describe("the node entry point", () => {
  it("registers serial, tcp, ble, slcan and socketcan with the core registry", () => {
    expect(openTransport("serial:///dev/tty.usbserial-1?baud=38400")).toBeInstanceOf(
      SerialTransport,
    );
    expect(openTransport("tcp://192.168.80.1:35000")).toBeInstanceOf(TcpTransport);
    expect(openTransport("ble://vLinker%20FD?service=18f0&notify=2af0")).toBeInstanceOf(
      BleTransport,
    );
    expect(openTransport("slcan:///dev/ttyACM0?baud=921600")).toBeInstanceOf(RawCanTransport);
    expect(openTransport("socketcan://can0")).toBeInstanceOf(RawCanTransport);
  });

  it.each([
    "vLinker",
    "usb://x",
    "ble://",
    "tcp://hostonly",
    "tcp://h:port",
    "serial:///x?baud=fast",
    "slcan:///x?baud=fast",
  ])("refuses %s", (url) => {
    expect(() => openTransport(url)).toThrow(AdapterUrlError);
  });

  it("leaves the schemes it does not serve unregistered", () => {
    expect(() => openTransport("webserial://label")).toThrow(TransportError);
  });
});
