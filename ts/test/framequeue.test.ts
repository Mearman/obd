import { describe, expect, it } from "vitest";
import { CanFrame, FrameQueue, TransportError, TransportTimeout } from "../src/core/index.js";

const frame = (id: number): CanFrame => new CanFrame(id, Uint8Array.of(id & 0xff));

describe("FrameQueue", () => {
  it("serves frames in order of arrival", async () => {
    const queue = new FrameQueue();
    queue.push(frame(1));
    queue.push(frame(2));
    expect(queue.size).toBe(2);
    expect(await queue.receive(10)).toEqual(frame(1));
    expect(await queue.receive(10)).toEqual(frame(2));
  });

  it("hands a frame straight to a waiting read, oldest first", async () => {
    const queue = new FrameQueue();
    const first = queue.receive(1000);
    const second = queue.receive(1000);
    queue.push(frame(7));
    queue.push(frame(8));
    expect(await first).toEqual(frame(7));
    expect(await second).toEqual(frame(8));
  });

  it("times out when nothing arrives, and a frame arriving later is kept for the next read", async () => {
    const queue = new FrameQueue();
    await expect(queue.receive(5)).rejects.toThrow(TransportTimeout);
    queue.push(frame(3));
    expect(await queue.receive(5)).toEqual(frame(3));
  });

  it("delivers what is queued after a failure, then the failure", async () => {
    const queue = new FrameQueue();
    queue.push(frame(1));
    queue.fail(new TransportError("unplugged"));
    queue.fail(new TransportError("second failure is ignored"));
    queue.push(frame(2));
    expect(await queue.receive(5)).toEqual(frame(1));
    await expect(queue.receive(5)).rejects.toThrow("unplugged");
  });

  it("rejects a pending read at once when it fails", async () => {
    const queue = new FrameQueue();
    const pending = queue.receive(10_000);
    queue.fail(new TransportError("unplugged"));
    await expect(pending).rejects.toThrow("unplugged");
  });

  it("discards queued frames when closed", async () => {
    const queue = new FrameQueue();
    queue.push(frame(1));
    queue.close();
    await expect(queue.receive(5)).rejects.toThrow(/closed/);
  });

  it("fails rather than drop a frame when full", async () => {
    const queue = new FrameQueue(2);
    queue.push(frame(1));
    queue.push(frame(2));
    queue.push(frame(3));
    expect(await queue.receive(5)).toEqual(frame(1));
    expect(await queue.receive(5)).toEqual(frame(2));
    await expect(queue.receive(5)).rejects.toThrow(/overflowed/);
  });
});
