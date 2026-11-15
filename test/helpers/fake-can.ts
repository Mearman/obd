/** An in-memory CAN bus with ISO-TP speaking control units, for raw CAN link tests. */

import {
  CanFrame,
  Receiver,
  TransportTimeout,
  flowControlFrame,
  pad,
  segment,
  type CanLink,
} from "../../src/core/index.js";

/** Takes a reassembled request and returns (sender identifier, reply payload) pairs. */
export type CanResponder = (request: Uint8Array) => [number, Uint8Array][];

const FUNCTIONAL_11 = 0x7df;

/** A {@link CanLink} whose bus holds control units that answer requests, honouring flow control. */
export class FakeCanLink implements CanLink {
  readonly sent: CanFrame[] = [];
  readonly configured: [bitrate: number, listenOnly: boolean][] = [];
  opened = false;
  closed = false;
  /** The frames waiting to be received, in order. */
  readonly queue: CanFrame[] = [];

  private readonly receivers = new Map<number, Receiver>();
  // Consecutive frames each unit holds back, with the request identifier whose flow control
  // releases them.
  private readonly held = new Map<number, [requestId: number, frames: CanFrame[]]>();

  /**
   * @param responders The units on the bus, by request identifier.
   * @param responseIds The identifier each unit sends flow control from; a unit not listed uses the
   * request identifier plus 8.
   */
  constructor(
    readonly responders: Record<number, CanResponder>,
    private readonly responseIds: Readonly<Record<number, number>> = {},
  ) {}

  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }

  configure(bitrate: number, listenOnly: boolean): Promise<void> {
    this.configured.push([bitrate, listenOnly]);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  receive(): Promise<CanFrame> {
    const frame = this.queue.shift();
    return frame === undefined
      ? Promise.reject(new TransportTimeout("nothing on the fake bus"))
      : Promise.resolve(frame);
  }

  send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    const kind = (frame.data[0] ?? 0) >> 4;
    if (kind === 3) {
      // Flow control from the tester releases the consecutive frames the unit held back.
      for (const [sender, [requestId, frames]] of [...this.held]) {
        if (requestId === frame.canId) {
          this.queue.push(...frames);
          this.held.delete(sender);
        }
      }
      return Promise.resolve();
    }
    let receiver = this.receivers.get(frame.canId);
    if (receiver === undefined) {
      receiver = new Receiver();
      this.receivers.set(frame.canId, receiver);
    }
    const received = receiver.feed(frame.canId, frame.data);
    if (received.sendFlowControl) {
      const sender = this.responseIds[frame.canId] ?? frame.canId + 8;
      this.queue.push(new CanFrame(sender, flowControlFrame(), frame.extended));
    }
    if (received.message === undefined) return Promise.resolve();
    const targets =
      frame.canId === FUNCTIONAL_11
        ? Object.keys(this.responders).map(Number)
        : frame.canId in this.responders
          ? [frame.canId]
          : [];
    for (const target of targets) {
      for (const [sender, payload] of this.responders[target]?.(received.message) ?? []) {
        const frames = segment(payload).map((data) => new CanFrame(sender, data, frame.extended));
        const [first, ...rest] = frames;
        if (first !== undefined) this.queue.push(first);
        if (rest.length > 0) this.held.set(sender, [target, rest]);
      }
    }
    return Promise.resolve();
  }

  /** Puts a frame on the bus as if another node sent it. */
  inject(canId: number, data: Uint8Array, extended = false): void {
    this.queue.push(new CanFrame(canId, pad(data), extended));
  }
}

/** One unit reached with CAN extended addressing: its address byte and how it answers. */
export interface AddressedUnit {
  readonly address: number;
  readonly respond: CanResponder;
}

/**
 * A CAN bus whose units share one request identifier and are told apart by the first data byte,
 * as BMW units are: every frame to a unit starts with its address, every frame a unit sends starts
 * with the tester address. Units reply on the response base plus their address.
 */
export class ExtendedAddressCanLink implements CanLink {
  readonly sent: CanFrame[] = [];
  readonly queue: CanFrame[] = [];
  private readonly receivers = new Map<number, Receiver>();
  private readonly held = new Map<number, CanFrame[]>();

  constructor(
    private readonly requestId: number,
    private readonly responseBase: number,
    private readonly tester: number,
    private readonly units: readonly AddressedUnit[],
  ) {}

  open(): Promise<void> {
    return Promise.resolve();
  }

  configure(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  receive(): Promise<CanFrame> {
    const frame = this.queue.shift();
    return frame === undefined
      ? Promise.reject(new TransportTimeout("nothing on the fake bus"))
      : Promise.resolve(frame);
  }

  send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    if (frame.canId !== this.requestId) return Promise.resolve();
    const unit = this.units.find((candidate) => candidate.address === frame.data[0]);
    if (unit === undefined) return Promise.resolve();
    const replyId = this.responseBase + unit.address;
    if ((frame.data[1] ?? 0) >> 4 === 3) {
      // Flow control from the tester releases the frames the unit held back.
      this.queue.push(...(this.held.get(unit.address) ?? []));
      this.held.delete(unit.address);
      return Promise.resolve();
    }
    let receiver = this.receivers.get(unit.address);
    if (receiver === undefined) {
      receiver = new Receiver(unit.address);
      this.receivers.set(unit.address, receiver);
    }
    const received = receiver.feed(frame.canId, frame.data);
    if (received.sendFlowControl) {
      this.queue.push(new CanFrame(replyId, flowControlFrame(0, 0, this.tester), false));
    }
    if (received.message === undefined) return Promise.resolve();
    for (const [, payload] of unit.respond(received.message)) {
      const [first, ...rest] = segment(payload, this.tester).map(
        (data) => new CanFrame(replyId, data, false),
      );
      if (first !== undefined) this.queue.push(first);
      if (rest.length > 0) this.held.set(unit.address, rest);
    }
    return Promise.resolve();
  }
}
