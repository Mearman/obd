/**
 * SocketCAN, the Linux kernel's CAN interface: `can0`, `vcan0`, a candleLight adapter running
 * gs_usb firmware, and anything else the kernel exposes as a CAN device. Linux only: Node has no
 * built-in CAN socket, so frames go through the optional `socketcan` package (a native addon that
 * is built on Linux and skipped everywhere else).
 *
 * The bit rate and listen-only mode belong to the interface and are set outside this tool, for
 * example `ip link set can0 type can bitrate 500000 listen-only on`.
 * Source: https://docs.kernel.org/networking/can.html
 */

import { CanFrame, MAX_DATA, type CanLink } from "../core/can.js";
import { FrameQueue } from "../core/framequeue.js";
import { RawCanTransport } from "../core/rawcan.js";
import { TransportError, type AdapterAddress } from "../core/transport.js";
import { errorText } from "./inbox.js";

/** A frame as the `socketcan` package reports it: `ext`, `rtr` and `err` are present only when set. */
export interface SocketCanMessage {
  readonly id: number;
  readonly ext?: boolean;
  readonly rtr?: boolean;
  readonly err?: boolean;
  readonly data: Uint8Array;
}

/** A frame as the `socketcan` package takes it. */
export interface SocketCanOutgoing {
  readonly id: number;
  readonly ext: boolean;
  readonly rtr: boolean;
  readonly data: Buffer;
}

/** The part of a `socketcan` raw channel the link uses. */
export interface SocketCanChannel {
  /** Registers `callback` for every frame the interface delivers. Its argument comes from native code and is checked before use. */
  addListener(event: "onMessage", callback: (message: unknown) => void): void;
  /** Starts delivering frames. */
  start(): void;
  /** Stops delivering frames and releases the socket; the channel cannot be started again. */
  stop(): void;
  /** Sends one frame; throws when the interface refuses it. */
  send(message: SocketCanOutgoing): void;
}

/** Opens a raw channel on the named interface. Rejects when the interface cannot be opened. */
export type SocketCanChannelFactory = (interfaceName: string) => Promise<SocketCanChannel>;

function member(target: unknown, key: string): unknown {
  return typeof target === "object" && target !== null && key in target
    ? Reflect.get(target, key)
    : undefined;
}

/** Wraps a channel object from the native package, checking that it has the methods the link calls. */
function wrapChannel(raw: unknown): SocketCanChannel {
  const method = (name: string): ((...args: unknown[]) => unknown) => {
    const candidate = member(raw, name);
    if (typeof candidate !== "function") {
      throw new TransportError(`the socketcan package's channel has no ${name} method`);
    }
    return (...args) => {
      const result: unknown = Reflect.apply(candidate, raw, args);
      return result;
    };
  };
  const addListener = method("addListener");
  const start = method("start");
  const stop = method("stop");
  const send = method("send");
  return {
    addListener: (event, callback) => {
      addListener(event, callback);
    },
    start: () => {
      start();
    },
    stop: () => {
      stop();
    },
    send: (message) => {
      send(message);
    },
  };
}

/**
 * Opens a channel through the `socketcan` package. The package loads on first use, so importing
 * `obd-read/node` never needs it.
 *
 * @throws TransportError when the package is missing or its native addon was not built (pnpm skips
 * install scripts here: run `pnpm rebuild socketcan` on Linux), or the interface cannot be opened.
 */
export const openSystemSocketCanChannel: SocketCanChannelFactory = async (interfaceName) => {
  // A variable specifier keeps the Linux-only optional dependency out of the type graph, so
  // typechecking does not depend on the platform it is installed on.
  const specifier = "socketcan";
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw new TransportError(
      `the socketcan package is not usable here (it is Linux only and must be built: pnpm rebuild socketcan): ${errorText(error)}`,
      { cause: error },
    );
  }
  const create =
    member(loaded, "createRawChannel") ?? member(member(loaded, "default"), "createRawChannel");
  if (typeof create !== "function") {
    throw new TransportError("the socketcan package has no createRawChannel function");
  }
  try {
    return wrapChannel(Reflect.apply(create, loaded, [interfaceName, false]));
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(`cannot open CAN interface ${interfaceName}: ${errorText(error)}`, {
      cause: error,
    });
  }
};

/** The data frame a message carries, or `undefined` for a remote, error or CAN FD frame. */
function frameOf(message: unknown): CanFrame | undefined {
  const id = member(message, "id");
  const data = member(message, "data");
  if (typeof id !== "number" || !(data instanceof Uint8Array)) {
    throw new TransportError("the socketcan package delivered something that is not a CAN frame");
  }
  if (member(message, "rtr") === true || member(message, "err") === true) return undefined;
  if (data.length > MAX_DATA) return undefined;
  return new CanFrame(id, Uint8Array.from(data), member(message, "ext") === true);
}

/** A raw CAN socket bound to one SocketCAN interface. */
export class SocketCanLink implements CanLink {
  readonly #interface: string;
  readonly #openChannel: SocketCanChannelFactory;
  readonly #platform: string;
  #channel: SocketCanChannel | undefined;
  #queue = new FrameQueue();

  /**
   * @param interfaceName The kernel interface, such as `can0`.
   * @param openChannel Opens the channel; defaults to the `socketcan` package.
   * @param platform The operating system, as `process.platform` names it.
   */
  constructor(
    interfaceName: string,
    openChannel: SocketCanChannelFactory = openSystemSocketCanChannel,
    platform: string = process.platform,
  ) {
    this.#interface = interfaceName;
    this.#openChannel = openChannel;
    this.#platform = platform;
  }

  /** @throws TransportError off Linux, or when the interface cannot be opened. */
  async open(): Promise<void> {
    if (this.#channel !== undefined) return;
    if (this.#platform !== "linux") {
      throw new TransportError(
        `SocketCAN is a Linux feature and this is ${this.#platform}: use an slcan:// adapter, or webusb:// in a browser for a candleLight adapter`,
      );
    }
    const channel = await this.#openChannel(this.#interface);
    const queue = new FrameQueue();
    channel.addListener("onMessage", (message) => {
      try {
        const frame = frameOf(message);
        if (frame !== undefined) queue.push(frame);
      } catch (error) {
        queue.fail(
          error instanceof TransportError
            ? error
            : new TransportError(`cannot read ${this.#interface}: ${errorText(error)}`, {
                cause: error,
              }),
        );
      }
    });
    try {
      channel.start();
    } catch (error) {
      throw new TransportError(`cannot start ${this.#interface}: ${errorText(error)}`, {
        cause: error,
      });
    }
    this.#queue = queue;
    this.#channel = channel;
  }

  /** Does nothing: the interface's bit rate and listen-only mode are set outside the program. */
  configure(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) return Promise.resolve();
    this.#channel = undefined;
    this.#queue.close();
    try {
      channel.stop();
    } catch (error) {
      return Promise.reject(
        new TransportError(`cannot close ${this.#interface}: ${errorText(error)}`, {
          cause: error,
        }),
      );
    }
    return Promise.resolve();
  }

  /** @throws TransportError when the link is not open or the interface refuses the frame. */
  send(frame: CanFrame): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined)
      return Promise.reject(new TransportError("SocketCAN link is not open"));
    try {
      channel.send({
        id: frame.canId,
        ext: frame.extended,
        rtr: false,
        data: Buffer.from(frame.data),
      });
    } catch (error) {
      return Promise.reject(
        new TransportError(`cannot send on ${this.#interface}: ${errorText(error)}`, {
          cause: error,
        }),
      );
    }
    return Promise.resolve();
  }

  /**
   * @throws TransportTimeout when no frame arrives in `timeoutMs`.
   * @throws TransportError when the link is not open or the interface delivered something unreadable.
   */
  receive(timeoutMs: number): Promise<CanFrame> {
    if (this.#channel === undefined) {
      return Promise.reject(new TransportError("SocketCAN link is not open"));
    }
    return this.#queue.receive(timeoutMs);
  }
}

/** Builds the `socketcan` transport for an adapter URL: an ELM327 look-alike on a raw CAN interface. */
export function socketcanTransportFor(
  address: AdapterAddress,
  openChannel: SocketCanChannelFactory = openSystemSocketCanChannel,
  platform: string = process.platform,
): RawCanTransport {
  return new RawCanTransport(
    new SocketCanLink(address.target, openChannel, platform),
    `SocketCAN ${address.target}`,
  );
}
