/**
 * A session that answers from a capture instead of an adapter, so the readers that drive a live session decode a capture with the same code.
 *
 * {@link ReplayElm} is an {@link Elm} whose requests are looked up in a capture's exchanges by addressing and request bytes, on a compatible bus. Addressing calls change only what is looked up; nothing is sent anywhere. Each lookup takes the next unused exchange for that request in capture order and, once those are used, the last one again, so a reader that asks twice reads what the car said. A request the capture does not hold throws {@link NotCaptured}, or {@link NotCapturedBroadcast} for a broadcast, which the readers treat as a unit that did not answer. This module is platform-free.
 */

import { fromHex, toUpperHex } from "./bytes.js";
import { AdapterUnsupported, Elm, ElmError, NoResponse, type LinkState } from "./elm.js";
import {
  addressKey,
  busesCompatible,
  describeAddress,
  type Exchange,
  type ExchangeAddress,
} from "./exchange.js";
import type { Permit } from "./guard.js";
import { TransportError, TransportTimeout, type Transport } from "./transport.js";

/** A request the decoder asked for is not in the capture. */
export class NotCaptured extends ElmError {
  override name = "NotCaptured";
}

/**
 * A broadcast request the decoder asked for is not in the capture. It is a {@link NoResponse}, so a legislated reader treats it as a read no unit answered; the decoder lists it as not captured.
 */
export class NotCapturedBroadcast extends NoResponse {
  override name = "NotCapturedBroadcast";
}

/**
 * A strict replay was asked for something its capture does not hold: the live read it replays stopped before asking. No reader catches it, so the replay stops at the same point.
 */
export class CaptureEnded extends Error {
  override name = "CaptureEnded";
}

/** A link that has no adapter behind it: every use fails. */
const NO_ADAPTER: Transport = {
  open: () => Promise.reject(new TransportError("a replayed capture has no adapter")),
  close: () => Promise.resolve(),
  write: () => Promise.reject(new TransportError("a replayed capture has no adapter")),
  read: () => Promise.reject(new TransportError("a replayed capture has no adapter")),
};

/** The key a request is looked up by: where it went and its bytes. */
function lookupKey(address: ExchangeAddress, request: string): string {
  return `${addressKey(address)}|${request}`;
}

/** The replies or failure an exchange recorded, as the session returns or throws them. */
function settle(exchange: Exchange): Map<number, Uint8Array[]> {
  const { outcome } = exchange;
  switch (outcome.kind) {
    case "replies":
      return new Map(
        outcome.replies.map(({ sender, messages }) => [
          sender,
          messages.map((hex) => fromHex(hex)),
        ]),
      );
    case "no-response":
      throw new NoResponse(outcome.message);
    case "adapter-error":
      throw outcome.error === "AdapterUnsupported"
        ? new AdapterUnsupported(outcome.message)
        : new ElmError(outcome.message);
    case "transport-error":
      throw outcome.error === "TransportTimeout"
        ? new TransportTimeout(outcome.message)
        : new TransportError(outcome.message);
  }
}

/** A session over a capture's exchanges. */
export class ReplayElm extends Elm {
  private readonly byKey = new Map<string, Exchange[]>();
  private readonly cursors = new Map<string, number>();
  private readonly used = new Set<number>();
  private readonly absent: string[] = [];

  /**
   * @param exchanges The capture's exchanges, in order.
   * @param state The bus and addressing to start in, as the live session was when its reads began; defaults to neither.
   * @param strict Throw {@link CaptureEnded} for a request the capture does not hold, instead of {@link NotCaptured}: for replaying a live read that failed, which must stop where it stopped.
   */
  constructor(
    exchanges: readonly Exchange[],
    state?: LinkState,
    private readonly strict = false,
  ) {
    super(NO_ADAPTER);
    for (const exchange of exchanges) {
      const key = lookupKey(exchange.address, exchange.request);
      const list = this.byKey.get(key);
      if (list === undefined) this.byKey.set(key, [exchange]);
      else list.push(exchange);
    }
    if (state !== undefined) this.setState(state);
  }

  /** The sequence numbers of every exchange a read used. */
  get served(): ReadonlySet<number> {
    return this.used;
  }

  /** Every request a read asked for that the capture does not hold, as `<address> <request>`, in the order asked. */
  get missing(): readonly string[] {
    return this.absent;
  }

  /** Whether the capture holds `request` (hexadecimal) to `address` on a bus compatible with the current one. */
  holds(address: ExchangeAddress, request: string): boolean {
    return this.candidates(address, request).length > 0;
  }

  override initialise(): Promise<never> {
    return Promise.reject(new ElmError("a replayed capture has no adapter to initialise"));
  }

  override command(): Promise<never> {
    return Promise.reject(new ElmError("a replayed capture has no adapter to send commands to"));
  }

  override selectCan(idBits: number, bitrate: number): Promise<void> {
    if (idBits !== 11 && idBits !== 29) {
      return Promise.reject(
        new ElmError(`CAN identifiers are 11 or 29 bits, not ${String(idBits)}`),
      );
    }
    this.setState({ bus: { kind: "can", idBits, bitrate } });
    return Promise.resolve();
  }

  override setHeader(canId: number): Promise<void> {
    this.setState({ address: { mode: "functional", requestId: canId } });
    return Promise.resolve();
  }

  override addressUnit(
    requestId: number,
    responseId: number,
    extendedAddress?: number,
    idBits?: 11 | 29,
  ): Promise<void> {
    const { bus } = this.state;
    // As a live session does, a unit of another width moves the session to that width at the rate already selected.
    if (idBits !== undefined && bus?.kind === "can" && bus.idBits !== idBits) {
      this.setState({ bus: { ...bus, idBits } });
    }
    const kline = bus?.kind === "kline";
    this.setState({
      address: {
        mode: "physical",
        requestId,
        responseId: kline ? null : responseId,
        extendedAddress: extendedAddress ?? null,
      },
    });
    return Promise.resolve();
  }

  override addressFunctional(requestId?: number): Promise<void> {
    const kline = this.state.bus?.kind === "kline";
    this.setState({
      address: { mode: "functional", requestId: kline ? null : (requestId ?? null) },
    });
    return Promise.resolve();
  }

  override addressAnyReply(requestId: number): Promise<void> {
    this.setState({ address: { mode: "any-reply", requestId } });
    return Promise.resolve();
  }

  /** Sets the bus and addressing directly, for a decoder that starts where a capture's reads were made. */
  moveTo(state: Partial<LinkState>): void {
    this.setState(state);
  }

  private candidates(address: ExchangeAddress, request: string): Exchange[] {
    const bus = this.state.bus;
    return (this.byKey.get(lookupKey(address, request)) ?? []).filter((exchange) =>
      busesCompatible(bus, exchange.bus),
    );
  }

  protected override send(permit: Permit): Promise<Map<number, Uint8Array[]>> {
    const { address } = this.state;
    const request = toUpperHex(permit.payload);
    const found = this.candidates(address, request);
    if (found.length === 0) {
      const what = `${describeAddress(address)} ${request}`;
      this.absent.push(what);
      const message = `request ${what} is not in the capture`;
      if (this.strict) return Promise.reject(new CaptureEnded(message));
      return Promise.reject(
        address?.mode === "functional"
          ? new NotCapturedBroadcast(message)
          : new NotCaptured(message),
      );
    }
    const key = lookupKey(address, request);
    const cursor = this.cursors.get(key) ?? 0;
    const exchange = found[Math.min(cursor, found.length - 1)];
    if (exchange === undefined) return Promise.reject(new RangeError("no exchange to replay"));
    this.cursors.set(key, cursor + 1);
    this.used.add(exchange.seq);
    // settle throws the error the exchange recorded; the executor turns that into the rejection.
    return new Promise((resolve) => {
      resolve(settle(exchange));
    });
  }
}
