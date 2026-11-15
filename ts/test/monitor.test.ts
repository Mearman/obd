import { describe, expect, it } from "vitest";
import {
  CanFrame,
  GuardError,
  MonitorFilter,
  OptionError,
  RawCanTransport,
  TransportTimeout,
  asciiDecode,
  asciiEncode,
  concatBytes,
  formatFrame,
  monitorCommand,
  parseStreamLine,
  runMonitor,
  type LogSink,
  type MonitorOptions,
  type Transport,
} from "../src/core/index.js";
import { FakeCanLink } from "./helpers/fake-can.js";
import { FakeElmCore } from "./helpers/fake-elm.js";

/** A scripted adapter that streams frames after STM or ATMA until it is sent any byte. */
class MonitoringAdapter implements Transport {
  readonly core: FakeElmCore;
  monitoring = false;
  stopped = false;
  private out: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly stream: readonly string[],
    stn: boolean,
  ) {
    this.core = new FakeElmCore({}, stn ? { stnIdentity: "STN1110 v4.2" } : {});
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.monitoring) {
      this.monitoring = false;
      this.stopped = true;
      this.out = concatBytes(this.out, asciiEncode("STOPPED\r\r>"));
      return Promise.resolve();
    }
    const text = asciiDecode(data).trim();
    if (text === "STM" || text === "ATMA") {
      this.core.sent.push(text);
      this.monitoring = true;
      this.out = concatBytes(
        this.out,
        asciiEncode(this.stream.map((line) => `${line}\r`).join("")),
      );
      return Promise.resolve();
    }
    this.out = concatBytes(this.out, this.core.feed(data));
    return Promise.resolve();
  }

  read(): Promise<Uint8Array> {
    if (this.out.length === 0) return Promise.reject(new TransportTimeout("quiet"));
    const data = this.out.slice(0, 7);
    this.out = this.out.slice(7);
    return Promise.resolve(data);
  }
}

/** Runs the monitor command on a transport and collects what it prints. */
class Run {
  readonly lines: string[] = [];

  constructor(private readonly transport: Transport) {}

  async go(options: Partial<MonitorOptions> = {}): Promise<number> {
    return runMonitor(
      { adapter: "tcp://fake:1", idBits: 11, bitrate: 500_000, ...options },
      (line) => this.lines.push(line),
      () => this.transport,
    );
  }

  get output(): string {
    return this.lines.join("\n");
  }

  /** The log lines that start with a timestamp, split into identifier and data. */
  frames(): string[][] {
    return this.lines
      .filter((line) => line.startsWith("20"))
      .map((line) => line.split(" ").slice(1));
  }
}

const STREAM = ["7E8064100BE3FA813", "7E1034100BE", "BUFFER FULL", "5A0", "7DF02010C"];

it("only allows listening commands", () => {
  for (const text of [
    "ATMA",
    "STM",
    "STFAC",
    "ATCRA7E8",
    "ATCRA",
    "STFPA 07E8,07FF",
    "STFBA 07DF,07FF",
    "STFFCA 07E0,07FF",
    "ATCF7E8",
    "ATCM7F8",
    "STCMM 0",
  ]) {
    expect(monitorCommand(text)).toBe(text);
  }
  for (const text of [
    "0100",
    "STCMM 1",
    "STCMM 2",
    "ATSH7E0",
    "STPX d:0100",
    "ATFCSH7E0",
    "ATZ",
    "ATCRA7E8 ;",
    "ATCAF0",
  ]) {
    expect(() => monitorCommand(text)).toThrow(GuardError);
  }
});

it("filters by pass, block and flow-control identifiers", () => {
  expect(new MonitorFilter().accepts(0x123)).toBe(true);
  expect(new MonitorFilter([], [0x123]).accepts(0x123)).toBe(false);
  const keep = new MonitorFilter([0x7e8], [], [0x7e0]);
  expect(keep.accepts(0x7e8)).toBe(true);
  expect(keep.accepts(0x7e0)).toBe(true);
  expect(keep.accepts(0x7df)).toBe(false);
  expect(new MonitorFilter([0x7e8], [0x7e8]).accepts(0x7e8)).toBe(false);
});

it("formats log lines and parses stream lines", () => {
  const moment = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
  expect(formatFrame(moment, 0x7e8, Uint8Array.of(6, 0x41), 11)).toBe(
    "2026-01-02T03:04:05.678+00:00 7E8 0641",
  );
  expect(formatFrame(moment, 0x18daf110, new Uint8Array(0), 29).endsWith(" 18DAF110")).toBe(true);
  expect(parseStreamLine("7E8 06 41 00", 11)).toEqual([0x7e8, Uint8Array.of(6, 0x41, 0)]);
  expect(parseStreamLine("7E8", 11)).toEqual([0x7e8, new Uint8Array(0)]);
  expect(parseStreamLine("BUFFER FULL", 11)).toBeUndefined();
  expect(parseStreamLine("7E8064", 11)).toBeUndefined();
});

describe("through an adapter", () => {
  it("filters an STN adapter in hardware and never acknowledges", async () => {
    const adapter = new MonitoringAdapter(STREAM, true);
    const session = new Run(adapter);
    expect(await session.go({ ids: [0x7e8, 0x7e1], block: [0x7df], count: 2 })).toBe(0);
    expect(adapter.core.sent.slice(-7)).toEqual([
      "ATSP6",
      "STFAC",
      "STFPA 07E8,07FF",
      "STFPA 07E1,07FF",
      "STFBA 07DF,07FF",
      "STCMM0",
      "STM",
    ]);
    expect(adapter.core.requests).toEqual([]);
    expect(adapter.stopped).toBe(true);
    expect(session.frames()).toEqual([
      ["7E8", "064100BE3FA813"],
      ["7E1", "034100BE"],
    ]);
    expect(session.output).toContain("2 frames logged");
  });

  it("uses one receive address and software filters on a plain adapter", async () => {
    const adapter = new MonitoringAdapter(STREAM, false);
    const session = new Run(adapter);
    expect(await session.go({ ids: [0x7e8], block: [0x7e1], durationMs: 50 })).toBe(0);
    expect(adapter.core.sent).toContain("ATCRA7E8");
    expect(adapter.core.sent).toContain("ATMA");
    expect(
      adapter.core.sent.some((line) => line.startsWith("STF") || line.startsWith("STCMM")),
    ).toBe(false);
    expect(session.frames().map((frame) => frame[0])).toEqual(["7E8"]);
    expect(session.lines).toContain("# adapter: BUFFER FULL");
  });

  it("shares one filter and mask between several identifiers on a plain adapter", async () => {
    const adapter = new MonitoringAdapter(STREAM, false);
    await new Run(adapter).go({ ids: [0x7e8, 0x7e9], durationMs: 50 });
    expect(adapter.core.sent).toContain("ATCF7E8");
    expect(adapter.core.sent).toContain("ATCM7FE");
  });
});

describe("through a raw link", () => {
  it("is listened to complete and never transmits", async () => {
    const link = new FakeCanLink({});
    for (const [canId, data] of [
      [0x7e8, Uint8Array.of(0x03, 0x41, 0x00, 0xbe)],
      [0x7df, Uint8Array.of(0x02, 0x01, 0x00)],
      [0x123, Uint8Array.of(0x01)],
    ] as const) {
      link.inject(canId, data);
    }
    const session = new Run(new RawCanTransport(link));
    expect(await session.go({ block: [0x7df], count: 2 })).toBe(0);
    expect(link.sent).toEqual([]);
    expect(link.configured).toEqual([[500_000, true]]);
    expect(link.opened && link.closed).toBe(true);
    expect(session.frames()).toEqual([
      ["7E8", "034100BECCCCCCCC"],
      ["123", "01CCCCCCCCCCCCCC"],
    ]);
    expect(session.output).toContain("2 frames logged");
  });

  it("writes the log to the destination it is given", async () => {
    const link = new FakeCanLink({});
    link.inject(0x7e8, Uint8Array.of(0x01));
    const written: string[] = [];
    let closed = false;
    const sink: LogSink = {
      write: (line) => {
        written.push(line);
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const session = new Run(new RawCanTransport(link));
    const output = { label: "bus.log", open: () => Promise.resolve(sink) };
    expect(await session.go({ count: 1, output })).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.split(" ")[1]).toBe("7E8");
    expect(closed).toBe(true);
    expect(session.output).toContain("1 frames logged to bus.log");
  });

  it("leaves the link alone when the destination refuses", async () => {
    const link = new FakeCanLink({});
    const session = new Run(new RawCanTransport(link));
    const output = {
      label: "bus.log",
      open: () => Promise.reject(new OptionError("bus.log already exists")),
    };
    await expect(session.go({ output })).rejects.toThrow(/already exists/);
    expect(link.opened).toBe(false);
  });
});

it("requires identifiers that fit the frame format", async () => {
  const session = new Run(new RawCanTransport(new FakeCanLink({})));
  await expect(session.go({ ids: [0x800] })).rejects.toThrow(/does not fit 11 bits/);
  expect(new CanFrame(0x7ff, new Uint8Array(0)).canId).toBe(0x7ff);
});
