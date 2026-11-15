import { describe, expect, it } from "vitest";
import {
  CanFrame,
  FlowStatus,
  IsoTpError,
  PADDING,
  Receiver,
  TransportTimeout,
  flowControlFrame,
  isotpReassemble,
  parseFlowControl,
  segment,
  sendMessage,
  separationMs,
  type CanLink,
} from "../src/core/index.js";
import { isotpFrames } from "./helpers/fake-elm.js";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function rstrip(data: Uint8Array, fill: number): Uint8Array {
  let end = data.length;
  while (end > 0 && data[end - 1] === fill) end -= 1;
  return data.slice(0, end);
}

it("makes a short message one padded frame", () => {
  expect(segment(bytes(0x10, 0x92))).toEqual([
    Uint8Array.of(0x02, 0x10, 0x92, ...new Array<number>(5).fill(PADDING)),
  ]);
});

describe("segmentation matches the adapter layer's reassembly", () => {
  it.each([8, 13, 14, 20, 100, 4095])("for %i bytes", (length) => {
    const payload = Uint8Array.from({ length }, (_, index) => index % 251);
    const frames = segment(payload);
    expect(frames.every((frame) => frame.length === 8)).toBe(true);
    expect(frames[0]?.slice(0, 2)).toEqual(bytes(0x10 | (length >> 8), length & 0xff));
    expect(isotpReassemble(frames.map((frame) => [0x7e8, frame]))).toEqual(
      new Map([[0x7e8, [payload]]]),
    );
    expect(rstrip(frames[0] ?? new Uint8Array(0), PADDING)).toEqual(isotpFrames(payload)[0]);
  });
});

it("wraps sequence numbers after fifteen", () => {
  const frames = segment(new Uint8Array(6 + 7 * 17));
  expect(frames.slice(1).map((frame) => (frame[0] ?? 0) & 0x0f)).toEqual([
    ...Array.from({ length: 15 }, (_, index) => index + 1),
    0,
    1,
  ]);
  expect(frames.slice(1).every((frame) => (frame[0] ?? 0) >> 4 === 2)).toBe(true);
});

it.each([new Uint8Array(0), new Uint8Array(4096)])("refuses an unsendable message", (payload) => {
  expect(() => segment(payload)).toThrow(IsoTpError);
});

describe("Receiver", () => {
  it("reassembles per sender and asks for flow control once", () => {
    const payload = Uint8Array.from({ length: 30 }, (_, index) => index);
    const frames = segment(payload);
    const receiver = new Receiver();
    const first = receiver.feed(0x7e8, frames[0] ?? new Uint8Array(0));
    expect(first.sendFlowControl).toBe(true);
    expect(first.message).toBeUndefined();
    const other = receiver.feed(0x7e9, segment(bytes(0x41, 0x00))[0] ?? new Uint8Array(0));
    expect(other.message).toEqual(bytes(0x41, 0x00));
    let done = first;
    for (const frame of frames.slice(1)) {
      done = receiver.feed(0x7e8, frame);
      expect(done.sendFlowControl).toBe(false);
    }
    expect(done.message).toEqual(payload);
    expect(done.frames).toEqual(frames);
    expect(receiver.incomplete()).toEqual([]);
  });

  it("ignores traffic that is not its conversation", () => {
    const receiver = new Receiver();
    expect(receiver.feed(0x7e8, flowControlFrame()).message).toBeUndefined();
    expect(receiver.feed(0x7e8, bytes(0x21, ...new Array<number>(7).fill(0)))).toEqual(
      receiver.feed(0x7e8, flowControlFrame()),
    );
  });

  it.each([
    new Uint8Array(0),
    bytes(0x00, 1),
    bytes(0x09, 1, 2),
    bytes(0x10, 0x03, 0, 0, 0, 0, 0, 0),
    bytes(0x10, 20),
    bytes(0x40),
  ])("treats the malformed frame %j as an error", (data) => {
    expect(() => new Receiver().feed(0x7e8, data)).toThrow(IsoTpError);
  });

  it("treats a broken sequence as an error and forgets the message", () => {
    const frames = segment(new Uint8Array(30));
    const receiver = new Receiver();
    receiver.feed(0x7e8, frames[0] ?? new Uint8Array(0));
    expect(() => receiver.feed(0x7e8, frames[2] ?? new Uint8Array(0))).toThrow(/sequence/);
    expect(receiver.incomplete()).toEqual([]);
  });
});

it("parses flow control", () => {
  const control = parseFlowControl(bytes(0x30, 4, 0x0a));
  expect([control.status, control.blockSize, control.separationMs]).toEqual([
    FlowStatus.CONTINUE,
    4,
    10,
  ]);
  expect(separationMs(0xf3)).toBeCloseTo(0.3);
  for (const bad of [bytes(0x33, 0, 0), bytes(0x30, 0, 0x80), bytes(0x20, 0, 0), bytes(0x30)]) {
    expect(() => parseFlowControl(bad)).toThrow(IsoTpError);
  }
});

/** A link that hands out scripted frames in order and records what was sent. */
class ScriptedLink implements CanLink {
  readonly sent: CanFrame[] = [];

  constructor(readonly script: CanFrame[]) {}

  open(): Promise<void> {
    return Promise.resolve();
  }

  configure(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    return Promise.resolve();
  }

  receive(): Promise<CanFrame> {
    const frame = this.script.shift();
    if (frame === undefined) return Promise.reject(new TransportTimeout("script exhausted"));
    return Promise.resolve(frame);
  }
}

function flow(status: number, block = 0): CanFrame {
  return new CanFrame(0x7e8, bytes(0x30 | status, block, 0));
}

describe("sendMessage", () => {
  it("waits for flow control each block", async () => {
    const payload = Uint8Array.from({ length: 30 }, (_, index) => index); // first frame plus four more
    const stray = new CanFrame(0x123, bytes(0x01, 0x02));
    const link = new ScriptedLink([flow(0, 2), stray, flow(0, 2)]);
    const meanwhile = await sendMessage(link, 0x7e0, false, payload, 0x7e8, 100);
    expect(link.sent.map((frame) => frame.data)).toEqual(segment(payload));
    expect(meanwhile).toEqual([stray]);
    expect(link.script).toEqual([]);
  });

  it("defers the next block on wait frames", async () => {
    const link = new ScriptedLink([flow(1), flow(1), flow(0)]);
    await sendMessage(link, 0x7e0, false, new Uint8Array(20), 0x7e8, 100);
    expect(link.sent).toHaveLength(segment(new Uint8Array(20)).length);
  });

  it.each([
    [[], "no flow control"],
    [[flow(2)], "cannot take"],
    [Array.from({ length: 11 }, () => flow(1)), "kept the sender waiting"],
  ])("fails on the flow control %j", async (script, message) => {
    await expect(
      sendMessage(new ScriptedLink(script), 0x7e0, false, new Uint8Array(20), 0x7e8, 100),
    ).rejects.toThrow(message);
  });

  it("needs no flow control for a single frame", async () => {
    const link = new ScriptedLink([]);
    expect(await sendMessage(link, 0x7e0, false, bytes(0x01, 0x00), 0x7e8, 100)).toEqual([]);
    expect(link.sent).toHaveLength(1);
  });
});

describe("CanFrame", () => {
  it("refuses an identifier that does not fit and data that is too long", () => {
    expect(() => new CanFrame(0x800, new Uint8Array(0))).toThrow(RangeError);
    expect(new CanFrame(0x800, new Uint8Array(0), true).extended).toBe(true);
    expect(() => new CanFrame(0x20000000, new Uint8Array(0), true)).toThrow(RangeError);
    expect(() => new CanFrame(0x7e0, new Uint8Array(9))).toThrow(RangeError);
  });
});
