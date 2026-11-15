/**
 * The receive side of a callback-driven CAN link: frames pushed by the device layer, drained by
 * {@link CanLink.receive}.
 */

import type { CanFrame } from "./can.js";
import { TransportError, TransportTimeout } from "./transport.js";

declare const setTimeout: (callback: () => void, milliseconds: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/** Default capacity of a {@link FrameQueue}, in frames: far above any burst between two reads. */
export const DEFAULT_FRAME_CAPACITY = 4096;

interface Waiter {
  resolve(frame: CanFrame): void;
  reject(error: Error): void;
  timer: unknown;
}

/**
 * A bounded queue of received frames.
 *
 * Reads are served in order of arrival. A queue ends in one of two ways. {@link fail} records why
 * the link broke: frames already queued are still delivered, then every read rejects with that
 * error. {@link close} is a deliberate release: queued frames are discarded and every pending and
 * later read rejects.
 */
export class FrameQueue {
  readonly #capacity: number;
  readonly #frames: CanFrame[] = [];
  readonly #waiters: Waiter[] = [];
  #ended: Error | undefined;

  /** @param capacity Most frames held unread. A push beyond it fails the queue. */
  constructor(capacity: number = DEFAULT_FRAME_CAPACITY) {
    this.#capacity = capacity;
  }

  /** Frames queued and not yet read. */
  get size(): number {
    return this.#frames.length;
  }

  /**
   * Adds a received frame, handing it straight to the oldest waiting read if there is one.
   *
   * Ignored once the queue has ended. Fails the queue with a {@link TransportError} when holding
   * the frame would exceed the capacity, since dropping it silently would corrupt a reply.
   */
  push(frame: CanFrame): void {
    if (this.#ended !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (this.#frames.length >= this.#capacity) {
      this.fail(
        new TransportError(
          `receive queue overflowed (${String(this.#capacity)} frames): the bus is busier than it is read`,
        ),
      );
      return;
    }
    this.#frames.push(frame);
  }

  /**
   * Returns the oldest queued frame, waiting up to `timeoutMs` for one.
   *
   * @throws TransportTimeout if none arrives in time.
   * @throws TransportError if the queue has failed or closed and nothing is queued.
   */
  receive(timeoutMs: number): Promise<CanFrame> {
    const queued = this.#frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended !== undefined) return Promise.reject(this.#ended);
    return new Promise<CanFrame>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new TransportTimeout(`no CAN frame in ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /**
   * Records that the link broke with `error`. Waiting reads reject at once; reads after that
   * deliver what is still queued and then reject. The first end wins.
   */
  fail(error: Error): void {
    if (this.#ended !== undefined) return;
    this.#ended = error;
    this.#rejectWaiters(error);
  }

  /** Ends the queue deliberately: discards queued frames and rejects pending and later reads. */
  close(): void {
    if (this.#ended === undefined) this.#ended = new TransportError("the link is closed");
    this.#frames.length = 0;
    this.#rejectWaiters(this.#ended);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
