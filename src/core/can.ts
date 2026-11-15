/**
 * Links that carry raw CAN frames, beside the byte-pipe links that carry an ELM327 conversation.
 */

/** Data bytes in a classic CAN frame. */
export const MAX_DATA = 8;

/** Largest 11-bit identifier. */
export const MAX_STANDARD_ID = 0x7ff;

/** Largest 29-bit identifier. */
export const MAX_EXTENDED_ID = 0x1fffffff;

/** One classic CAN data frame. Remote, error and CAN FD frames are not represented. */
export class CanFrame {
  /**
   * @throws RangeError when the identifier does not fit the frame format (11 bits, or 29 when
   * `extended`), or the data is longer than {@link MAX_DATA} bytes.
   */
  constructor(
    readonly canId: number,
    readonly data: Uint8Array,
    readonly extended = false,
  ) {
    const limit = extended ? MAX_EXTENDED_ID : MAX_STANDARD_ID;
    if (!Number.isInteger(canId) || canId < 0 || canId > limit) {
      throw new RangeError(`CAN identifier 0x${canId.toString(16)} does not fit the frame format`);
    }
    if (data.length > MAX_DATA) {
      throw new RangeError(
        `a CAN frame carries at most ${String(MAX_DATA)} bytes, got ${String(data.length)}`,
      );
    }
  }
}

/** A raw CAN channel: frames in and out, with the bus speed chosen once it is open. */
export interface CanLink {
  /** Opens the device. Rejects with TransportError if it cannot be reached. */
  open(): Promise<void>;

  /**
   * Starts the bus at `bitrate` bit/s, in listen-only mode when `listenOnly` is set.
   *
   * A link whose bit rate and mode belong to the operating system's interface (SocketCAN) leaves
   * both to the interface.
   */
  configure(bitrate: number, listenOnly: boolean): Promise<void>;

  /** Releases the device. Safe to call when it never opened. */
  close(): Promise<void>;

  /** Puts one frame on the bus. Rejects with TransportError when the link is not open or fails. */
  send(frame: CanFrame): Promise<void>;

  /**
   * Returns the next data frame on the bus.
   *
   * Rejects with TransportTimeout when none arrives within `timeoutMs` milliseconds.
   */
  receive(timeoutMs: number): Promise<CanFrame>;
}
