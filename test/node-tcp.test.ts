import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  DiagProtocol,
  Elm,
  TransportError,
  TransportTimeout,
  parseAdapterUrl,
  permit,
} from "../src/core/index.js";
import { TcpTransport, tcpTransportFor } from "../src/node/tcp.js";
import { FakeElmCore, KwpEcu } from "./helpers/fake-elm.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

/** Serves a fake adapter on a free local port; every connection shares `core`. */
async function serve(core: FakeElmCore, onConnection?: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onConnection?.(socket);
    socket.on("data", (data) => {
      socket.write(core.feed(Buffer.from(data)));
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe("TcpTransport", () => {
  it("carries an ELM session end to end", async () => {
    const port = await serve(new FakeElmCore({ 0x784: new KwpEcu(0x785, []).respond }));
    const transport = new TcpTransport("127.0.0.1", port);
    await transport.open();
    try {
      const elm = new Elm(transport);
      await elm.initialise();
      await elm.selectCan(11, 500_000);
      await elm.addressUnit(0x784, 0x785);
      const replies = await elm.request(
        await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x92)),
      );
      expect(replies.get(0x785)).toEqual([Uint8Array.of(0x50, 0x92)]);
      await expect(transport.read(50)).rejects.toThrow(TransportTimeout);
    } finally {
      await transport.close();
    }
  });

  it("returns everything that has arrived in one read", async () => {
    let connection: Socket | undefined;
    const port = await serve(new FakeElmCore({}), (socket) => {
      connection = socket;
    });
    const transport = new TcpTransport("127.0.0.1", port);
    await transport.open();
    try {
      await transport.write(Uint8Array.of(0x0d));
      await transport.read(1000);
      connection?.write(Uint8Array.of(1, 2));
      connection?.write(Uint8Array.of(3));
      const first = await transport.read(1000);
      const rest = first.length < 3 ? await transport.read(1000) : new Uint8Array(0);
      expect([...first, ...rest]).toEqual([1, 2, 3]);
    } finally {
      await transport.close();
    }
  });

  it("refuses a connection nothing is listening for", async () => {
    const port = await serve(new FakeElmCore({}));
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    await expect(new TcpTransport("127.0.0.1", port).open()).rejects.toThrow(/cannot connect/);
  });

  it("reports the bytes the adapter sent before closing, then the closed connection", async () => {
    const port = await serve(new FakeElmCore({}), (socket) => {
      socket.end(Uint8Array.of(0x41));
    });
    const transport = new TcpTransport("127.0.0.1", port);
    await transport.open();
    try {
      expect(await transport.read(1000)).toEqual(Uint8Array.of(0x41));
      const failure = transport.read(1000);
      await expect(failure).rejects.toThrow(TransportError);
      await expect(failure).rejects.not.toThrow(TransportTimeout);
      await expect(transport.read(1000)).rejects.toThrow(/closed the connection/);
    } finally {
      await transport.close();
    }
  });

  it("fails reads and writes before open and after close, and closes twice without error", async () => {
    const transport = new TcpTransport("127.0.0.1", 1);
    await expect(transport.read(10)).rejects.toThrow(/not open/);
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
    await transport.close();
    const port = await serve(new FakeElmCore({}));
    const open = new TcpTransport("127.0.0.1", port);
    await open.open();
    await expect(open.open()).rejects.toThrow(/already open/);
    await open.close();
    await open.close();
    await expect(open.write(Uint8Array.of(1))).rejects.toThrow(/not open/);
  });

  it("can be opened again after it was closed", async () => {
    const port = await serve(new FakeElmCore({}));
    const transport = new TcpTransport("127.0.0.1", port);
    await transport.open();
    await transport.close();
    await transport.open();
    await transport.write(Uint8Array.of(0x0d));
    expect((await transport.read(1000)).length).toBeGreaterThan(0);
    await transport.close();
  });
});

describe("tcpTransportFor", () => {
  it("accepts host:port, including an IPv6 host with or without brackets", () => {
    for (const url of ["tcp://192.168.80.1:35000", "tcp://[::1]:35000", "tcp://::1:35000"]) {
      expect(tcpTransportFor(parseAdapterUrl(url))).toBeInstanceOf(TcpTransport);
    }
  });

  it.each(["tcp://hostonly", "tcp://h:port", "tcp://:35000", "tcp://h:0", "tcp://h:70000"])(
    "refuses %s",
    (url) => {
      expect(() => tcpTransportFor(parseAdapterUrl(url))).toThrow(AdapterUrlError);
    },
  );
});
