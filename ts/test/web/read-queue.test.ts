import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportError, TransportTimeout } from "../../src/core/index.js";
import { ReadQueue } from "../../src/web/read-queue.js";

afterEach(() => {
  vi.useRealTimers();
});

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe("ReadQueue", () => {
  it("returns buffered bytes joined in arrival order", async () => {
    const queue = new ReadQueue();
    queue.push(bytes(1, 2));
    queue.push(bytes(3));
    expect(await queue.read(10)).toEqual(bytes(1, 2, 3));
    expect(queue.size).toBe(0);
  });

  it("hands a push straight to a waiting read, oldest first", async () => {
    const queue = new ReadQueue();
    const first = queue.read(1000);
    const second = queue.read(1000);
    queue.push(bytes(7));
    queue.push(bytes(8));
    expect(await first).toEqual(bytes(7));
    expect(await second).toEqual(bytes(8));
  });

  it("copies pushed bytes so a reused source buffer cannot change them", async () => {
    const queue = new ReadQueue();
    const source = bytes(1, 2);
    queue.push(source);
    source[0] = 9;
    expect(await queue.read(10)).toEqual(bytes(1, 2));
  });

  it("ignores empty pushes", async () => {
    vi.useFakeTimers();
    const queue = new ReadQueue();
    queue.push(new Uint8Array());
    const read = queue.read(50);
    const outcome = expect(read).rejects.toBeInstanceOf(TransportTimeout);
    await vi.advanceTimersByTimeAsync(50);
    await outcome;
  });

  it("times out with TransportTimeout and then serves later data", async () => {
    vi.useFakeTimers();
    const queue = new ReadQueue();
    const read = queue.read(100);
    const outcome = expect(read).rejects.toBeInstanceOf(TransportTimeout);
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
    queue.push(bytes(5));
    expect(await queue.read(100)).toEqual(bytes(5));
  });

  it("does not hand bytes to a read that already timed out", async () => {
    vi.useFakeTimers();
    const queue = new ReadQueue();
    const read = queue.read(10);
    const outcome = expect(read).rejects.toBeInstanceOf(TransportTimeout);
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
    queue.push(bytes(1));
    expect(queue.size).toBe(1);
  });

  it("delivers buffered bytes after fail, then rejects with the failure", async () => {
    const queue = new ReadQueue();
    queue.push(bytes(1));
    queue.fail(new TransportError("gone"));
    expect(await queue.read(10)).toEqual(bytes(1));
    await expect(queue.read(10)).rejects.toThrow("gone");
  });

  it("rejects a waiting read when it fails, keeping the first failure", async () => {
    const queue = new ReadQueue();
    const pending = queue.read(1000);
    queue.fail(new TransportError("first"));
    queue.fail(new TransportError("second"));
    await expect(pending).rejects.toThrow("first");
    await expect(queue.read(10)).rejects.toThrow("first");
  });

  it("rejects a waiting read on close and discards buffered bytes", async () => {
    const queue = new ReadQueue();
    const pending = queue.read(1000);
    queue.close();
    await expect(pending).rejects.toBeInstanceOf(TransportError);
    queue.push(bytes(1));
    expect(queue.size).toBe(0);
    await expect(queue.read(10)).rejects.toThrow("closed");
  });

  it("discards buffered bytes on close", async () => {
    const queue = new ReadQueue();
    queue.push(bytes(1));
    queue.close();
    await expect(queue.read(10)).rejects.toThrow("closed");
  });

  it("fails loudly rather than dropping bytes when the buffer is full", async () => {
    const queue = new ReadQueue(4);
    queue.push(bytes(1, 2, 3));
    queue.push(bytes(4, 5));
    expect(await queue.read(10)).toEqual(bytes(1, 2, 3));
    await expect(queue.read(10)).rejects.toThrow("overflowed");
  });
});
