/** TCP link, for Wi-Fi adapters that expose their ELM327 interface on a socket. */

import { connect, type Socket } from "node:net";
import {
  AdapterUrlError,
  TransportError,
  type AdapterAddress,
  type Transport,
} from "../core/transport.js";
import { Inbox, errorText } from "./inbox.js";

/** How long {@link TcpTransport.open} waits for the connection by default. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** An ELM327 adapter reached over a TCP socket. */
export class TcpTransport implements Transport {
  private socket: Socket | undefined;
  private closing = false;
  private readonly inbox = new Inbox();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
  ) {}

  /** @throws TransportError if the connection is refused, fails or takes too long. */
  async open(): Promise<void> {
    if (this.socket !== undefined) throw new TransportError("TCP link is already open");
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = connect({ host: this.host, port: this.port });
      const fail = (reason: string): void => {
        attempt.destroy();
        reject(
          new TransportError(`cannot connect to ${this.host}:${String(this.port)}: ${reason}`),
        );
      };
      const timer = setTimeout(() => {
        fail(`no connection in ${(this.connectTimeoutMs / 1000).toFixed(1)} s`);
      }, this.connectTimeoutMs);
      attempt.once("error", (error) => {
        clearTimeout(timer);
        fail(error.message);
      });
      attempt.once("connect", () => {
        clearTimeout(timer);
        attempt.removeAllListeners("error");
        resolve(attempt);
      });
    });
    socket.setNoDelay(true);
    this.inbox.reset();
    this.closing = false;
    socket.on("data", (chunk: Uint8Array) => {
      this.inbox.push(chunk);
    });
    socket.on("error", (error) => {
      this.inbox.fail(new TransportError(`the connection failed: ${errorText(error)}`));
    });
    socket.on("close", () => {
      if (!this.closing) this.inbox.fail(new TransportError("the adapter closed the connection"));
    });
    this.socket = socket;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) return;
    this.socket = undefined;
    this.closing = true;
    if (socket.closed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
      socket.destroy();
    });
  }

  async write(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) throw new TransportError("TCP link is not open");
    await new Promise<void>((resolve, reject) => {
      socket.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new TransportError(`TCP write failed: ${error.message}`));
      });
    });
  }

  /**
   * Returns everything received since the last read, waiting up to `timeoutMs` for the first byte.
   *
   * @throws TransportTimeout when nothing arrives within `timeoutMs`.
   * @throws TransportError when the link is not open, or the adapter closed the connection (after
   * the bytes it sent first have been returned).
   */
  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.socket === undefined)
      return Promise.reject(new TransportError("TCP link is not open"));
    return this.inbox.read(timeoutMs);
  }
}

/**
 * Builds a {@link TcpTransport} for a `tcp://host:port` address.
 *
 * @throws AdapterUrlError when the target is not a host and a port from 1 to 65535. An IPv6 host
 * may be written with or without brackets.
 */
export function tcpTransportFor(address: AdapterAddress): TcpTransport {
  const split = address.target.lastIndexOf(":");
  const portText = address.target.slice(split + 1);
  const host = address.target.slice(0, Math.max(split, 0)).replace(/^\[(.*)\]$/, "$1");
  const port = /^\d+$/.test(portText) ? Number(portText) : 0;
  if (split < 0 || host === "" || port < 1 || port > 65_535) {
    throw new AdapterUrlError(
      `tcp adapter URL needs host:port, got ${JSON.stringify(address.target)}`,
    );
  }
  return new TcpTransport(host, port);
}
