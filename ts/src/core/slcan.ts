/**
 * SLCAN, the ASCII serial protocol for CAN adapters, over any byte-pipe link.
 *
 * Commands and frames end in a carriage return and the adapter answers a command with a carriage
 * return, or a bell on failure. `S0` to `S8` choose 10, 20, 50, 100, 125, 250, 500, 800 kbit/s and
 * 1 Mbit/s, `O` opens the bus, `L` opens it listen-only and `C` closes it. A frame is `t` and three
 * hexadecimal identifier digits (`T` and eight for an extended identifier), one data length digit
 * and the data in hexadecimal.
 * Source: the Linux kernel's SLCAN driver,
 * https://github.com/torvalds/linux/blob/master/drivers/net/can/slcan/slcan-core.c
 *
 * A candleLight adapter flashed with SLCAN firmware speaks this; one with gs_usb firmware is a
 * SocketCAN device on Linux instead.
 */

import { asciiDecode, asciiEncode, concatBytes, fromHex, hexNumber, toUpperHex } from "./bytes.js";
import { CanFrame, type CanLink } from "./can.js";
import { TransportError, type Transport } from "./transport.js";

/** The `S` digit that selects each bit rate. */
export const BITRATE_CODES: ReadonlyMap<number, number> = new Map([
  [10_000, 0],
  [20_000, 1],
  [50_000, 2],
  [100_000, 3],
  [125_000, 4],
  [250_000, 5],
  [500_000, 6],
  [800_000, 7],
  [1_000_000, 8],
]);

const CARRIAGE_RETURN = 0x0d;
const BELL = 0x07;

/** How long a command may wait for its acknowledgement, in milliseconds. */
const COMMAND_TIMEOUT_MS = 2000;

const FRAME = /^(?:t([0-9A-F]{3})|T([0-9A-F]{8}))([0-8])((?:[0-9A-F]{2})*)$/i;

/** The SLCAN text for one data frame, ending in a carriage return. */
export function encodeFrame(frame: CanFrame): Uint8Array {
  const identifier = frame.extended
    ? `T${hexNumber(frame.canId, 8)}`
    : `t${hexNumber(frame.canId, 3)}`;
  return asciiEncode(`${identifier}${String(frame.data.length)}${toUpperHex(frame.data)}\r`);
}

/**
 * Parses one received line. Returns `undefined` for a line that is not a data frame, such as a
 * command acknowledgement or a remote frame.
 *
 * @throws TransportError for a data frame whose declared length disagrees with its data.
 */
export function decodeFrame(line: Uint8Array): CanFrame | undefined {
  const text = asciiDecode(line);
  const match = FRAME.exec(text);
  if (match === null) return undefined;
  const [, standard, extended, length = "", data = ""] = match;
  const payload = fromHex(data);
  if (payload.length !== Number(length)) {
    throw new TransportError(`SLCAN frame ${JSON.stringify(text)} declares ${length} data bytes`);
  }
  if (extended !== undefined) return new CanFrame(Number.parseInt(extended, 16), payload, true);
  return new CanFrame(Number.parseInt(standard ?? "", 16), payload);
}

/** A CAN channel on an SLCAN adapter reached through a byte-pipe transport. */
export class SlcanLink implements CanLink {
  private buffer: Uint8Array = new Uint8Array(0);
  private started = false;

  constructor(private readonly transport: Transport) {}

  open(): Promise<void> {
    return this.transport.open();
  }

  /** The next line from the adapter, or a lone bell when it reported a failure. */
  private async nextLine(timeoutMs: number): Promise<Uint8Array> {
    for (;;) {
      const cr = this.buffer.indexOf(CARRIAGE_RETURN);
      const bell = this.buffer.indexOf(BELL);
      const ends = [cr, bell].filter((index) => index >= 0);
      if (ends.length > 0) {
        const end = Math.min(...ends);
        const terminator = this.buffer[end];
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        return terminator === BELL ? Uint8Array.of(BELL) : line;
      }
      this.buffer = concatBytes(this.buffer, await this.transport.read(timeoutMs));
    }
  }

  /**
   * Sends one command and waits for its acknowledgement, skipping frames that arrive first.
   *
   * @throws TransportError when the adapter answers with a bell, unless `allowRefusal` is set.
   */
  private async command(text: string, allowRefusal = false): Promise<void> {
    await this.transport.write(asciiEncode(`${text}\r`));
    for (;;) {
      const line = await this.nextLine(COMMAND_TIMEOUT_MS);
      if (line.length === 1 && line[0] === BELL) {
        if (allowRefusal) return;
        throw new TransportError(`the SLCAN adapter refused ${JSON.stringify(text)}`);
      }
      if (line.length === 0) return;
    }
  }

  async configure(bitrate: number, listenOnly: boolean): Promise<void> {
    const code = BITRATE_CODES.get(bitrate);
    if (code === undefined) {
      throw new TransportError(`an SLCAN adapter has no setting for ${String(bitrate)} bit/s`);
    }
    // Closing a channel that is already closed is refused by some adapters, which is not a failure.
    await this.command("C", true);
    await this.command(`S${String(code)}`);
    await this.command(listenOnly ? "L" : "O");
    this.started = true;
  }

  async close(): Promise<void> {
    try {
      if (this.started) await this.command("C", true);
    } finally {
      this.started = false;
      await this.transport.close();
    }
  }

  send(frame: CanFrame): Promise<void> {
    return this.transport.write(encodeFrame(frame));
  }

  async receive(timeoutMs: number): Promise<CanFrame> {
    for (;;) {
      const frame = decodeFrame(await this.nextLine(timeoutMs));
      if (frame !== undefined) return frame;
    }
  }
}
