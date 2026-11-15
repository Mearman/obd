import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  ScriptedTransport,
  TransportError,
  TransportTimeout,
  composeTransportHosts,
  fromHex,
  reconnectDelay,
  schemeTransportHost,
  RECONNECT_MAX_MS,
  type Transport,
} from "../src/core/index.js";
import { remoteTransportHost, serveTransports } from "../src/service/transport-link.js";

function echo(): ScriptedTransport {
  return new ScriptedTransport((written) => written);
}

function link(create: (url: string) => Transport) {
  const { port1, port2 } = new MessageChannel();
  const bridge = serveTransports(port1, create);
  const host = remoteTransportHost(port2, ["webbluetooth"]);
  return {
    bridge,
    host,
    dispose: () => {
      port1.close();
      port2.close();
    },
  };
}

describe("a transport owned by the page and used from a worker", () => {
  it("opens, writes, reads and closes through the port, bytes intact", async () => {
    const built: ScriptedTransport[] = [];
    const { host, dispose } = link(() => {
      const transport = echo();
      built.push(transport);
      return transport;
    });
    try {
      expect(host.schemes()).toEqual(["webbluetooth"]);
      expect(host.serves("webbluetooth://vLinker")).toBe(true);
      expect(host.serves("webserial://x")).toBe(false);
      const remote = host.create("webbluetooth://vLinker");
      await remote.open();
      await remote.write(fromHex("00FF10"));
      const first = await remote.read(100);
      expect(first.length).toBeGreaterThan(0);
      expect(built).toHaveLength(1);
      expect(built[0]?.opened).toBe(true);
      await remote.close();
      expect(built[0]?.closed).toBe(true);
    } finally {
      dispose();
    }
  });

  it("reports a read that times out as a timeout and any other failure as a transport error", async () => {
    const { host, dispose } = link(() => new ScriptedTransport(() => new Uint8Array(0)));
    try {
      const remote = host.create("webbluetooth://x");
      await remote.open();
      await expect(remote.read(5)).rejects.toBeInstanceOf(TransportTimeout);
      await remote.close();
      await expect(remote.read(5)).rejects.toBeInstanceOf(TransportError);
    } finally {
      dispose();
    }
  });

  it("surfaces a failed open as a transport error", async () => {
    const { host, dispose } = link(() => ({
      open: () => Promise.reject(new TransportError("no device chosen")),
      close: () => Promise.resolve(),
      write: () => Promise.resolve(),
      read: () => Promise.reject(new TransportError("closed")),
    }));
    try {
      await expect(host.create("webbluetooth://x").open()).rejects.toThrow("no device chosen");
    } finally {
      dispose();
    }
  });

  it("adopts a transport the page opened inside the user's gesture", async () => {
    const built: ScriptedTransport[] = [];
    const { bridge, host, dispose } = link(() => {
      const transport = echo();
      built.push(transport);
      return transport;
    });
    try {
      await bridge.prepare("webbluetooth://vLinker");
      expect(built).toHaveLength(1);
      await host.create("webbluetooth://vLinker").open();
      expect(built).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe("transport hosts", () => {
  it("send each URL to the first host that serves it and refuse the rest", () => {
    const first = schemeTransportHost(["tcp"], () => echo());
    const second = schemeTransportHost(["serial", "tcp"], () => echo());
    const both = composeTransportHosts(first, second);
    expect(both.schemes()).toEqual(["tcp", "serial"]);
    expect(both.serves("serial:///dev/x")).toBe(true);
    expect(both.serves("ble://x")).toBe(false);
    expect(() => both.create("ble://x")).toThrow(TransportError);
    expect(() => first.create("serial:///dev/x")).toThrow(TransportError);
  });
});

describe("the reconnection delay", () => {
  it("doubles from the base and stops at the cap", () => {
    expect([1, 2, 3, 4].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000]);
    expect(reconnectDelay(40)).toBe(RECONNECT_MAX_MS);
  });
});
