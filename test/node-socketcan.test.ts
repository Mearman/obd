import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CanFrame,
  DiagProtocol,
  Elm,
  RawCanTransport,
  TransportError,
  TransportTimeout,
  openTransport,
  parseAdapterUrl,
  permit,
} from "../src/core/index.js";
import {
  SOCKETCAN_BUILD_COMMAND,
  SocketCanLink,
  openSystemSocketCanChannel,
  socketcanTransportFor,
  type SocketCanChannel,
  type SocketCanChannelFactory,
  type SocketCanOutgoing,
} from "../src/node/socketcan.js";
import "../src/node/index.js";

/** A raw channel as the `socketcan` package provides it, with the interface's traffic scripted. */
class FakeChannel implements SocketCanChannel {
  readonly sent: SocketCanOutgoing[] = [];
  started = false;
  stopped = false;
  sendError: Error | undefined;
  stopError: Error | undefined;
  /** Called with each frame sent, to let a test play the bus. */
  onSend: ((message: SocketCanOutgoing) => void) | undefined;
  #listener: ((message: unknown) => void) | undefined;

  addListener(_event: "onMessage", callback: (message: unknown) => void): void {
    this.#listener = callback;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    if (this.stopError !== undefined) throw this.stopError;
    this.stopped = true;
  }

  send(message: SocketCanOutgoing): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(message);
    this.onSend?.(message);
  }

  /** Delivers what the native module would: a plain object, with flags only when set. */
  deliver(message: unknown): void {
    this.#listener?.(message);
  }
}

function link(
  channel = new FakeChannel(),
  platform = "linux",
): { channel: FakeChannel; link: SocketCanLink; opened: string[] } {
  const opened: string[] = [];
  const factory: SocketCanChannelFactory = (name) => {
    opened.push(name);
    return Promise.resolve(channel);
  };
  return { channel, link: new SocketCanLink("can0", factory, platform), opened };
}

describe("SocketCanLink", () => {
  it("opens the named interface and starts it", async () => {
    const { channel, link: can, opened } = link();
    await can.open();
    await can.open();
    expect(opened).toEqual(["can0"]);
    expect(channel.started).toBe(true);
  });

  it("is unsupported off Linux, naming the alternatives", async () => {
    const { link: can, opened } = link(new FakeChannel(), "darwin");
    await expect(can.open()).rejects.toThrow(
      /Linux feature and this is darwin.*slcan:\/\/.*webusb:\/\//,
    );
    await expect(can.open()).rejects.toBeInstanceOf(TransportError);
    expect(opened).toEqual([]);
  });

  it("leaves the bit rate to the interface", async () => {
    const { channel, link: can } = link();
    await can.open();
    await can.configure();
    expect(channel.sent).toEqual([]);
  });

  it("sends standard and extended frames", async () => {
    const { channel, link: can } = link();
    await can.open();
    await can.send(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)));
    await can.send(new CanFrame(0x18da10f1, Uint8Array.of(0xaa), true));
    expect(channel.sent.map((m) => [m.id, m.ext, m.rtr, [...m.data]])).toEqual([
      [0x7e0, false, false, [2, 0x10, 0x92]],
      [0x18da10f1, true, false, [0xaa]],
    ]);
  });

  it("receives data frames, in order, and skips remote, error and over-long ones", async () => {
    const { channel, link: can } = link();
    await can.open();
    channel.deliver({ id: 0x123, rtr: true, data: Buffer.alloc(0) });
    channel.deliver({ id: 0x4, err: true, data: Buffer.alloc(8) });
    channel.deliver({ id: 0x100, data: Buffer.alloc(12) });
    channel.deliver({ id: 0x7e8, data: Buffer.from([0x50, 0x92]), ts_sec: 1, ts_usec: 2 });
    channel.deliver({ id: 0x18daf110, ext: true, data: Buffer.alloc(0) });
    expect(await can.receive(100)).toEqual(new CanFrame(0x7e8, Uint8Array.of(0x50, 0x92)));
    expect(await can.receive(100)).toEqual(new CanFrame(0x18daf110, new Uint8Array(0), true));
    await expect(can.receive(20)).rejects.toThrow(TransportTimeout);
  });

  it("fails receiving, loudly, on something that is not a frame", async () => {
    const { channel, link: can } = link();
    await can.open();
    channel.deliver({ id: "0x7e8", data: Buffer.alloc(0) });
    await expect(can.receive(100)).rejects.toThrow(/not a CAN frame/);
  });

  it("wraps a refusal from the interface", async () => {
    const { channel, link: can } = link();
    await can.open();
    channel.sendError = new Error("No buffer space available");
    await expect(can.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(
      /cannot send on can0: No buffer space available/,
    );
  });

  it("needs to be open to send and receive", async () => {
    const { link: can } = link();
    await expect(can.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(/not open/);
    await expect(can.receive(10)).rejects.toThrow(/not open/);
  });

  it("stops the channel on close, and close is safe to repeat and before opening", async () => {
    const { channel, link: can } = link();
    await can.close();
    await can.open();
    const waiting = can.receive(5000);
    await can.close();
    await can.close();
    expect(channel.stopped).toBe(true);
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(can.receive(10)).rejects.toThrow(/not open/);
  });

  it("reports a failure to stop", async () => {
    const { channel, link: can } = link();
    await can.open();
    channel.stopError = new Error("bad file descriptor");
    await expect(can.close()).rejects.toThrow(/cannot close can0: bad file descriptor/);
  });
});

describe("the socketcan adapter URL", () => {
  it("is served by the Node entry point", () => {
    expect(openTransport("socketcan://can0")).toBeInstanceOf(RawCanTransport);
  });

  it("runs an ELM327 session on the interface", async () => {
    const channel = new FakeChannel();
    channel.onSend = (message) => {
      if (message.id === 0x7e0) {
        channel.deliver({
          id: 0x7e8,
          data: Buffer.from([0x02, 0x50, 0x92, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc]),
        });
      }
    };
    const transport = socketcanTransportFor(
      parseAdapterUrl("socketcan://can0"),
      () => Promise.resolve(channel),
      "linux",
    );
    await transport.open();
    const elm = new Elm(transport);
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x7e0, 0x7e8);
    const replies = await elm.request(
      await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x92)),
    );
    expect(replies).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
    await transport.close();
    expect(channel.stopped).toBe(true);
  });
});

describe("the socketcan package", () => {
  // pnpm skips `pnpm rebuild socketcan` for a package whose build the workspace denies, so the command the tool tells people to run has to allow that one build itself.
  it("is built by the command the tool names, which allows the build the workspace denies", () => {
    const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
    expect(workspace).toMatch(/^ {2}socketcan: false$/m);
    const { scripts } = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    const script = /^pnpm (\S+)$/.exec(SOCKETCAN_BUILD_COMMAND)?.[1];
    if (script === undefined) throw new Error(`not a pnpm script: ${SOCKETCAN_BUILD_COMMAND}`);
    expect(scripts[script]).toBe(`PNPM_CONFIG_ALLOW_BUILDS='{"socketcan":true}' pnpm rebuild socketcan`);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`\`${SOCKETCAN_BUILD_COMMAND}\``);
  });

  it("is reported as a TransportError where it is absent, unbuilt or has no such interface", async () => {
    await expect(openSystemSocketCanChannel("obdread-no-such-interface")).rejects.toBeInstanceOf(
      TransportError,
    );
  });
});
