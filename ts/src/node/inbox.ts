import { concatBytes } from "../core/bytes.js";
import { TransportError, TransportTimeout } from "../core/transport.js";

interface Waiter {
  resolve(data: Uint8Array): void;
  reject(error: TransportError): void;
  readonly timer: NodeJS.Timeout;
}

/**
 * The bytes a link has received and not yet handed to a reader.
 *
 * A read returns everything queued at that moment, so a reply split across arrivals is returned as
 * one chunk when the pieces are already here. After {@link fail}, queued bytes are still delivered
 * first and the failure surfaces on the read after them.
 */
export class Inbox {
  private chunks: Uint8Array[] = [];
  private failure: TransportError | undefined;
  private waiter: Waiter | undefined;

  /** Queues received bytes and wakes a pending read. Empty chunks are ignored. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(this.take());
    }
  }

  /** Records why the link can deliver no more bytes. Only the first failure is kept. */
  fail(error: TransportError): void {
    this.failure ??= error;
    const waiter = this.waiter;
    if (waiter !== undefined && this.chunks.length === 0) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  /** Discards queued bytes and any recorded failure, so a link can be opened again. */
  reset(): void {
    this.chunks = [];
    this.failure = undefined;
  }

  /**
   * Resolves with all queued bytes, waiting up to `timeoutMs` for the first.
   *
   * @throws TransportTimeout when nothing arrives in time.
   * @throws TransportError when the link has failed, or another read is already waiting.
   */
  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.chunks.length > 0) return Promise.resolve(this.take());
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.waiter !== undefined) {
      return Promise.reject(new TransportError("another read is already waiting on this link"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new TransportTimeout(`nothing received in ${(timeoutMs / 1000).toFixed(1)} s`));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  private take(): Uint8Array {
    const [only] = this.chunks;
    // A Node `Buffer` is viewed as a plain `Uint8Array`, so readers never see a subclass.
    const data =
      this.chunks.length === 1 && only !== undefined
        ? new Uint8Array(only.buffer, only.byteOffset, only.length)
        : concatBytes(...this.chunks);
    this.chunks = [];
    return data;
  }
}

/** Narrows a stream or notification payload to bytes. Node delivers `Buffer`, a `Uint8Array`. */
export function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  throw new TransportError(`the link delivered ${typeof chunk} data, not bytes`);
}

/** The text of a thrown value, for inclusion in a {@link TransportError} message. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
