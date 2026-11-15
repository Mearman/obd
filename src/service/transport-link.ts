/**
 * Transports reached over a message port: how a worker that hosts the service uses a transport that only exists on the page.
 *
 * Web Bluetooth is not exposed to workers, and the browser's device pickers need a user gesture on the page, so a transport can be owned by the page while the service that drives it runs in a dedicated worker. {@link serveTransports} runs on the page and owns the real transports. {@link remoteTransportHost} runs in the worker and builds {@link Transport}s that forward `open`, `close`, `write` and `read` to it, so everything above (the ELM session, the collector) is unaware of the hop. Bytes cross the port as hexadecimal text.
 *
 * The link is an oRPC contract served over the same message-port adapter the diagnostics service uses.
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink, type SupportedMessagePort } from "@orpc/client/message-port";
import { oc, type RouterContractClient } from "@orpc/contract";
import { ORPCError, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { z } from "zod";
import { fromHex, toUpperHex } from "../core/bytes.js";
import { startPort } from "./message-port.js";
import type { Scheme } from "../core/transport.js";
import { schemeTransportHost, type TransportHost } from "../core/transport-host.js";
import { TransportError, TransportTimeout, type Transport } from "../core/transport.js";

const idInput = z.object({ id: z.string().min(1) });
const done = z.object({ done: z.literal(true) });

/** The operations a page serves for the transports it owns. */
export const transportContract = {
  /** Opens the transport for an adapter URL; a transport the page prepared for that URL is adopted. */
  open: oc.input(idInput.extend({ adapter: z.string().min(1) })).output(done),
  close: oc.input(idInput).output(done),
  write: oc.input(idInput.extend({ hex: z.string() })).output(done),
  /** The next bytes, or a timeout when none arrive in time. */
  read: oc
    .input(idInput.extend({ timeoutMs: z.number().nonnegative() }))
    .output(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("data"), hex: z.string() }),
        z.object({ kind: z.literal("timeout") }),
      ]),
    ),
};

/** What the page keeps for the transports it owns. */
export interface TransportBridge {
  /**
   * Builds and opens the transport for `adapterUrl` now, so the device picker it shows runs inside the user's click. Call it first thing in the click handler; the service's later `open` adopts the result.
   *
   * @throws TransportError and AdapterUrlError as the transport's own `open` does.
   */
  prepare(adapterUrl: string): Promise<void>;
}

/**
 * Serves transports built by `create` on `port`, for a service in a worker.
 *
 * @param create Builds the unopened transport for an adapter URL on this page.
 */
export function serveTransports(
  port: SupportedMessagePort,
  create: (adapterUrl: string) => Transport,
): TransportBridge {
  const open = new Map<string, Transport>();
  const prepared = new Map<string, Transport>();
  const find = (id: string): Transport => {
    const transport = open.get(id);
    if (transport === undefined)
      throw new ORPCError("NOT_FOUND", { message: `no transport ${id}` });
    return transport;
  };
  const fail = (error: unknown): never => {
    throw new ORPCError("BAD_GATEWAY", {
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const os = implement(transportContract);
  const router = os.router({
    open: os.open.handler(async ({ input }) => {
      const ready = prepared.get(input.adapter);
      if (ready !== undefined) {
        prepared.delete(input.adapter);
        open.set(input.id, ready);
        return { done: true };
      }
      const transport = create(input.adapter);
      try {
        await transport.open();
      } catch (error) {
        return fail(error);
      }
      open.set(input.id, transport);
      return { done: true };
    }),
    close: os.close.handler(async ({ input }) => {
      const transport = open.get(input.id);
      open.delete(input.id);
      await transport?.close();
      return { done: true };
    }),
    write: os.write.handler(async ({ input }) => {
      try {
        await find(input.id).write(fromHex(input.hex));
      } catch (error) {
        return fail(error);
      }
      return { done: true };
    }),
    read: os.read.handler(async ({ input }) => {
      try {
        return { kind: "data", hex: toUpperHex(await find(input.id).read(input.timeoutMs)) };
      } catch (error) {
        if (error instanceof TransportTimeout) return { kind: "timeout" };
        return fail(error);
      }
    }),
  });
  new RPCHandler(router).upgrade(port);
  startPort(port);
  return {
    prepare: async (adapterUrl) => {
      const transport = create(adapterUrl);
      await transport.open();
      prepared.set(adapterUrl, transport);
    },
  };
}

type TransportClient = RouterContractClient<typeof transportContract>;

class RemoteTransport implements Transport {
  constructor(
    private readonly client: TransportClient,
    private readonly id: string,
    private readonly adapter: string,
  ) {}

  async open(): Promise<void> {
    await this.call(() => this.client.open({ id: this.id, adapter: this.adapter }));
  }

  async close(): Promise<void> {
    await this.call(() => this.client.close({ id: this.id }));
  }

  async write(data: Uint8Array): Promise<void> {
    await this.call(() => this.client.write({ id: this.id, hex: toUpperHex(data) }));
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    const reply = await this.call(() => this.client.read({ id: this.id, timeoutMs }));
    if (reply.kind === "timeout") {
      throw new TransportTimeout(`no bytes from ${this.adapter} within ${String(timeoutMs)} ms`);
    }
    return fromHex(reply.hex);
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ORPCError) throw new TransportError(error.message, { cause: error });
      throw error;
    }
  }
}

/**
 * A host whose transports for `schemes` live on the other end of `port`, served there by {@link serveTransports}.
 *
 * Each transport it builds opens, reads and writes through the page, and a failure the page reports surfaces as a {@link TransportError}.
 */
export function remoteTransportHost(
  port: SupportedMessagePort,
  schemes: readonly Scheme[],
): TransportHost {
  const client: TransportClient = createORPCClient(new RPCLink({ port }));
  startPort(port);
  let issued = 0;
  return schemeTransportHost(schemes, (adapterUrl) => {
    issued += 1;
    return new RemoteTransport(client, `remote-${String(issued)}`, adapterUrl);
  });
}
