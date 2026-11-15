/**
 * ISO 15765-2 (ISO-TP): segmenting a message into CAN frames, flow control and reassembly.
 *
 * Used by the raw CAN links, where no adapter firmware does it. Frame types by the high nibble of
 * the first data byte: 0 single frame, 1 first frame, 2 consecutive frame, 3 flow control.
 *
 * Under extended addressing the first data byte of every frame is the receiver's address and the
 * PCI byte follows it, so each frame carries one payload byte less. The ELM327 datasheet describes
 * the scheme ("the first byte is used for the receiver's (ie target's) address. The remaining seven
 * bytes are used as described previously"), and BMW units use it with the tester at 0xF1.
 * Source: ELM327 datasheet, "Using CAN Extended Addresses";
 * https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
 */

import { byteAt, concatBytes, hexNumber, toHex } from "./bytes.js";
import { MAX_DATA, CanFrame, type CanLink } from "./can.js";
import { sleep } from "./time.js";
import { TransportTimeout } from "./transport.js";

/**
 * Fill byte for the unused tail of a frame. Wikipedia recommends 0xCC; whether a given control unit
 * cares is unconfirmed.
 */
export const PADDING = 0xcc;

/** Largest message a twelve-bit first-frame length can announce. */
export const MAX_MESSAGE = 0xfff;

const SINGLE_FRAME_PAYLOAD = MAX_DATA - 1;
const FIRST_FRAME_PAYLOAD = MAX_DATA - 2;
const CONSECUTIVE_FRAME_PAYLOAD = MAX_DATA - 1;

/**
 * ISO 15765-2 extended addressing for one exchange: the byte each side puts first in its frames.
 */
export interface ExtendedAddressing {
  /** The address that starts every frame this side sends: the receiver's. */
  readonly target: number;
  /** The address that starts every frame sent to this side: its own. */
  readonly source: number;
}

/** How many "wait" flow-control frames a receiver may send before the sender gives up. */
export const MAX_WAITS = 10;

const SINGLE = 0;
const FIRST = 1;
const CONSECUTIVE = 2;
const FLOW_CONTROL = 3;

/** A message could not be sent or received as ISO 15765-2 requires. */
export class IsoTpError extends Error {
  override name = "IsoTpError";
}

/** The flow-control status nibble. */
export const FlowStatus = {
  CONTINUE: 0,
  WAIT: 1,
  OVERFLOW: 2,
} as const;

/** One of the {@link FlowStatus} values. */
export type FlowStatus = (typeof FlowStatus)[keyof typeof FlowStatus];

function isFlowStatus(value: number): value is FlowStatus {
  return Object.values<number>(FlowStatus).includes(value);
}

/** A receiver's flow-control frame: whether to continue, in blocks of what size, how far apart. */
export interface FlowControl {
  readonly status: FlowStatus;
  /** Frames per block; 0 means all of them. */
  readonly blockSize: number;
  /** The minimum gap between consecutive frames, in milliseconds. */
  readonly separationMs: number;
}

/** Fills a frame's data to the full eight bytes. */
export function pad(data: Uint8Array): Uint8Array {
  if (data.length >= MAX_DATA) return data;
  const out = new Uint8Array(MAX_DATA).fill(PADDING);
  out.set(data);
  return out;
}

/**
 * Splits one message into the data of its CAN frames, each padded to eight bytes.
 *
 * @param target The receiver's extended address, put first in every frame, for extended
 * addressing; each frame then carries one payload byte less. Absent for normal addressing.
 * @throws IsoTpError for an empty message or one longer than a first frame can announce.
 */
export function segment(payload: Uint8Array, target?: number): Uint8Array[] {
  if (payload.length === 0) throw new IsoTpError("an ISO-TP message cannot be empty");
  if (payload.length > MAX_MESSAGE) {
    throw new IsoTpError(
      `a message of ${String(payload.length)} bytes is longer than ISO-TP carries`,
    );
  }
  const prefix = target === undefined ? new Uint8Array(0) : Uint8Array.of(target);
  const lost = prefix.length;
  if (payload.length <= SINGLE_FRAME_PAYLOAD - lost) {
    return [pad(concatBytes(prefix, Uint8Array.of(payload.length), payload))];
  }
  const firstPayload = FIRST_FRAME_PAYLOAD - lost;
  const consecutivePayload = CONSECUTIVE_FRAME_PAYLOAD - lost;
  const frames = [
    concatBytes(
      prefix,
      Uint8Array.of((FIRST << 4) | (payload.length >> 8), payload.length & 0xff),
      payload.slice(0, firstPayload),
    ),
  ];
  let sequence = 1;
  for (let offset = firstPayload; offset < payload.length; offset += consecutivePayload) {
    frames.push(
      pad(
        concatBytes(
          prefix,
          Uint8Array.of((CONSECUTIVE << 4) | (sequence & 0x0f)),
          payload.slice(offset, offset + consecutivePayload),
        ),
      ),
    );
    sequence += 1;
  }
  return frames;
}

/**
 * A clear-to-send flow-control frame: `blockSize` frames per block (0 means all), `separation` as
 * the raw STmin byte, preceded by the receiver's extended address `target` when there is one.
 */
export function flowControlFrame(blockSize = 0, separation = 0, target?: number): Uint8Array {
  const control = Uint8Array.of((FLOW_CONTROL << 4) | FlowStatus.CONTINUE, blockSize, separation);
  return pad(target === undefined ? control : concatBytes(Uint8Array.of(target), control));
}

/**
 * Decodes a flow-control STmin byte into milliseconds: 0 to 127 are milliseconds, 0xF1 to 0xF9 are
 * 100 to 900 microseconds.
 *
 * @throws IsoTpError for a reserved value.
 */
export function separationMs(value: number): number {
  if (value <= 0x7f) return value;
  if (value >= 0xf1 && value <= 0xf9) return (value - 0xf0) / 10;
  throw new IsoTpError(`reserved separation time 0x${hexNumber(value, 2)}`);
}

/**
 * Reads a flow-control frame.
 *
 * @throws IsoTpError when it is not one or its status is reserved.
 */
export function parseFlowControl(data: Uint8Array): FlowControl {
  if (data.length < 3 || byteAt(data, 0) >> 4 !== FLOW_CONTROL) {
    throw new IsoTpError(`not a flow-control frame: ${toHex(data)}`);
  }
  const status = byteAt(data, 0) & 0x0f;
  if (!isFlowStatus(status)) throw new IsoTpError(`reserved flow status in ${toHex(data)}`);
  return { status, blockSize: byteAt(data, 1), separationMs: separationMs(byteAt(data, 2)) };
}

/** What one received frame meant. */
export interface Received {
  /** The completed message, when this frame finished one. */
  readonly message: Uint8Array | undefined;
  /** Every frame of the completed message. */
  readonly frames: readonly Uint8Array[];
  /** Whether the sender is waiting for a flow-control frame. */
  readonly sendFlowControl: boolean;
}

const NOTHING: Received = { message: undefined, frames: [], sendFlowControl: false };

interface Pending {
  readonly length: number;
  readonly data: number[];
  readonly frames: Uint8Array[];
  nextSequence: number;
}

/** Reassembles messages from received frames, one pending message per sender. */
export class Receiver {
  private readonly pending = new Map<number, Pending>();

  /**
   * @param source This side's extended address, for extended addressing: only frames that start
   * with it are addressed here, and it is removed before the PCI byte is read. Absent for normal
   * addressing.
   */
  constructor(private readonly source?: number) {}

  /**
   * Takes one frame from `sender`.
   *
   * Returns the completed message with all of its frames when this frame finished one, and whether
   * the sender is waiting for a flow-control frame. Flow-control frames, consecutive frames of a
   * message that was never started and, under extended addressing, frames addressed to another
   * receiver belong to another conversation and mean nothing here.
   *
   * @throws IsoTpError for a malformed frame or a break in a message's sequence.
   */
  feed(sender: number, frame: Uint8Array): Received {
    const who = hexNumber(sender, 1);
    if (frame.length === 0) throw new IsoTpError(`empty frame from ${who}`);
    if (this.source !== undefined && byteAt(frame, 0) !== this.source) return NOTHING;
    const data = this.source === undefined ? frame : frame.subarray(1);
    if (data.length === 0) throw new IsoTpError(`frame from ${who} holds only its address`);
    const first = byteAt(data, 0);
    const kind = first >> 4;
    if (kind === SINGLE) {
      const length = first & 0x0f;
      if (length === 0 || length > data.length - 1) {
        throw new IsoTpError(`bad single-frame length from ${who}: ${toHex(data)}`);
      }
      return { message: data.slice(1, 1 + length), frames: [frame], sendFlowControl: false };
    }
    if (kind === FIRST) {
      if (frame.length < MAX_DATA) {
        throw new IsoTpError(`short first frame from ${who}: ${toHex(frame)}`);
      }
      const length = ((first & 0x0f) << 8) | byteAt(data, 1);
      // A message that fits a single frame must not be sent as a first frame.
      if (length <= SINGLE_FRAME_PAYLOAD - (frame.length - data.length)) {
        throw new IsoTpError(`first frame from ${who} announces ${String(length)} bytes`);
      }
      this.pending.set(sender, {
        length,
        data: Array.from(data.subarray(2)),
        frames: [frame],
        nextSequence: 1,
      });
      return { message: undefined, frames: [], sendFlowControl: true };
    }
    if (kind === CONSECUTIVE) {
      const message = this.pending.get(sender);
      if (message === undefined) return NOTHING;
      if ((first & 0x0f) !== (message.nextSequence & 0x0f)) {
        this.pending.delete(sender);
        throw new IsoTpError(
          `sequence error from ${who}: expected ${String(message.nextSequence & 0x0f)}, ` +
            `got ${String(first & 0x0f)}`,
        );
      }
      message.nextSequence += 1;
      message.data.push(...data.subarray(1));
      message.frames.push(frame);
      if (message.data.length >= message.length) {
        this.pending.delete(sender);
        return {
          message: Uint8Array.from(message.data.slice(0, message.length)),
          frames: message.frames,
          sendFlowControl: false,
        };
      }
      return NOTHING;
    }
    if (kind === FLOW_CONTROL) return NOTHING;
    throw new IsoTpError(`unknown frame type from ${who}: ${toHex(data)}`);
  }

  /** The senders whose multi-frame message has not finished. */
  incomplete(): number[] {
    return Array.from(this.pending.keys());
  }
}

/**
 * Sends one message, waiting for the receiver's flow control between the frames of a long one.
 *
 * Returns the frames that arrived meanwhile from anyone but `flowControlId`'s flow control, so none
 * is lost.
 *
 * @param timeoutMs How long to wait for each flow-control frame, in milliseconds.
 * @param addressing The extended addresses, for extended addressing: every frame sent starts with
 * `target`, and only a flow-control frame that starts with `source` counts. Absent for normal
 * addressing.
 * @throws IsoTpError when no flow control arrives in time, the receiver reports overflow, or it
 * asks to wait more than {@link MAX_WAITS} times.
 */
export async function sendMessage(
  link: CanLink,
  canId: number,
  extended: boolean,
  payload: Uint8Array,
  flowControlId: number,
  timeoutMs: number,
  addressing?: ExtendedAddressing,
): Promise<CanFrame[]> {
  const frames = segment(payload, addressing?.target);
  await link.send(new CanFrame(canId, frameAt(frames, 0), extended));
  const meanwhile: CanFrame[] = [];
  let index = 1;
  while (index < frames.length) {
    const control = await awaitFlowControl(
      link,
      flowControlId,
      addressing?.source,
      timeoutMs,
      meanwhile,
    );
    let remainingInBlock = control.blockSize === 0 ? frames.length : control.blockSize;
    while (remainingInBlock > 0 && index < frames.length) {
      await link.send(new CanFrame(canId, frameAt(frames, index), extended));
      index += 1;
      remainingInBlock -= 1;
      if (control.separationMs > 0) await sleep(control.separationMs);
    }
  }
  return meanwhile;
}

function frameAt(frames: readonly Uint8Array[], index: number): Uint8Array {
  const frame = frames[index];
  if (frame === undefined) throw new RangeError(`frame ${String(index)} does not exist`);
  return frame;
}

async function awaitFlowControl(
  link: CanLink,
  flowControlId: number,
  source: number | undefined,
  timeoutMs: number,
  meanwhile: CanFrame[],
): Promise<FlowControl> {
  const who = hexNumber(flowControlId, 1);
  let waits = 0;
  for (;;) {
    let frame: CanFrame;
    try {
      frame = await link.receive(timeoutMs);
    } catch (error) {
      if (error instanceof TransportTimeout) {
        throw new IsoTpError(`no flow control from ${who}`, { cause: error });
      }
      throw error;
    }
    const addressed = source === undefined || frame.data[0] === source;
    const data = source === undefined ? frame.data : frame.data.subarray(1);
    const first = data[0];
    if (
      frame.canId !== flowControlId ||
      !addressed ||
      first === undefined ||
      first >> 4 !== FLOW_CONTROL
    ) {
      meanwhile.push(frame);
      continue;
    }
    const control = parseFlowControl(data);
    if (control.status === FlowStatus.OVERFLOW) {
      throw new IsoTpError(`${who} cannot take a message this long`);
    }
    if (control.status === FlowStatus.WAIT) {
      waits += 1;
      if (waits > MAX_WAITS) throw new IsoTpError(`${who} kept the sender waiting`);
      continue;
    }
    return control;
  }
}
