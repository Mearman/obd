import { TransportTimeout, type Transport } from "../transport.js";

/** Turns the bytes written to a scripted adapter into the bytes it replies with, possibly none. */
export type Responder = (written: Uint8Array) => Uint8Array;

/**
 * An in-process {@link Transport} for tests: every write is passed to a {@link Responder} and the
 * reply is queued for reads.
 *
 * A read hands back a reply in two pieces, as a real link splits it arbitrarily, and rejects with
 * {@link TransportTimeout} at once (it never waits) when nothing is queued.
 */
export class ScriptedTransport implements Transport {
  /** True once {@link open} has been called. */
  opened = false;
  /** True once {@link close} has been called. */
  closed = false;
  /** Every write, in order. */
  readonly written: Uint8Array[] = [];
  /** The `timeoutMs` of every read, in order. */
  readonly readTimeouts: number[] = [];

  private pending = new Uint8Array(0);

  constructor(private readonly respond: Responder) {}

  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  write(data: Uint8Array): Promise<void> {
    this.written.push(data);
    const reply = this.respond(data);
    const queued = new Uint8Array(this.pending.length + reply.length);
    queued.set(this.pending);
    queued.set(reply, this.pending.length);
    this.pending = queued;
    return Promise.resolve();
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    this.readTimeouts.push(timeoutMs);
    if (this.pending.length === 0) {
      return Promise.reject(new TransportTimeout("scripted adapter has nothing to say"));
    }
    const cut = Math.max(1, Math.floor(this.pending.length / 2));
    const data = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return Promise.resolve(data);
  }
}
