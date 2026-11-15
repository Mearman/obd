import { TransportError, TransportTimeout } from "../core/transport.js";

/** Default capacity of a {@link ReadQueue}, in bytes: far above any adapter's burst between reads. */
export const DEFAULT_QUEUE_CAPACITY = 1 << 20;

interface Waiter {
  resolve(data: Uint8Array): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The receive side of a browser transport: a bounded buffer that a reader loop or a notification
 * handler fills with {@link push} and that `Transport.read` drains with {@link read}.
 *
 * Reads are served in order of arrival. A queue ends in one of two ways. {@link fail} records why
 * the link broke: bytes already buffered are still delivered, then every read rejects with that
 * error. {@link close} is a deliberate release: buffered bytes are discarded and every pending and
 * later read rejects.
 */
export class ReadQueue {
  readonly #capacity: number;
  readonly #chunks: Uint8Array[] = [];
  readonly #waiters: Waiter[] = [];
  #buffered = 0;
  #ended: Error | undefined;

  /** @param capacity Most bytes held unread. A push beyond it fails the queue. */
  constructor(capacity: number = DEFAULT_QUEUE_CAPACITY) {
    this.#capacity = capacity;
  }

  /** Bytes buffered and not yet read. */
  get size(): number {
    return this.#buffered;
  }

  /**
   * Adds received bytes, handing them straight to the oldest waiting read if there is one.
   *
   * Ignored once the queue has ended. Fails the queue with a {@link TransportError} if holding the
   * bytes would exceed the capacity, since dropping them silently would corrupt a reply.
   */
  push(data: Uint8Array): void {
    if (this.#ended !== undefined || data.length === 0) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(data.slice());
      return;
    }
    if (this.#buffered + data.length > this.#capacity) {
      this.fail(
        new TransportError(
          `receive buffer overflowed (${String(this.#capacity)} bytes): the adapter is sending faster than it is read`,
        ),
      );
      return;
    }
    this.#chunks.push(data.slice());
    this.#buffered += data.length;
  }

  /**
   * Returns every buffered byte, at least one, waiting up to `timeoutMs` for the first.
   *
   * @throws TransportTimeout if nothing arrives in time.
   * @throws TransportError if the queue has failed or closed and nothing is buffered.
   */
  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.#buffered > 0) return Promise.resolve(this.#drain());
    if (this.#ended !== undefined) return Promise.reject(this.#ended);
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new TransportTimeout(`nothing received in ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /**
   * Records that the link broke with `error`. Waiting reads reject at once; reads after that
   * deliver what is still buffered and then reject. The first end wins.
   */
  fail(error: Error): void {
    if (this.#ended !== undefined) return;
    this.#ended = error;
    this.#rejectWaiters(error);
  }

  /** Ends the queue deliberately: discards buffered bytes and rejects pending and later reads. */
  close(): void {
    if (this.#ended === undefined) this.#ended = new TransportError("the link is closed");
    this.#chunks.length = 0;
    this.#buffered = 0;
    this.#rejectWaiters(this.#ended);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #drain(): Uint8Array {
    const out = new Uint8Array(this.#buffered);
    let offset = 0;
    for (const chunk of this.#chunks.splice(0)) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.#buffered = 0;
    return out;
  }
}
