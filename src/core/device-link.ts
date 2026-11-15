/**
 * The one connection a service holds to an adapter: its transport, its ELM session and the profile's bus.
 *
 * Every read or write of the adapter goes through {@link DeviceLink.withSession}, which runs one piece of work at a time, so a scan, a collection poll and a guarded operation never interleave their requests. The link holds no guard state: requests still pass `permit` in the layers below.
 *
 * This module is platform-free.
 */

import { Elm, Transcript, type AdapterInfo } from "./elm.js";
import { KLineElm, selectBus } from "./kline.js";
import type { Profile } from "./profile.js";
import type { TransportHost } from "./transport-host.js";
import type { Transport } from "./transport.js";

/** An operation needed a connection and there is none. */
export class NotConnected extends Error {
  override name = "NotConnected";
}

/** The link is already connected, to something else than the caller asked for. */
export class LinkBusy extends Error {
  override name = "LinkBusy";
}

/** An open connection. */
export interface LinkSession {
  /** The vehicle profile the connection was opened with, or `undefined` for a generic OBD-II session that speaks the legislated services only. */
  readonly profile: Profile | undefined;
  /** The adapter URL it was opened with. */
  readonly adapterUrl: string;
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
}

/** What {@link DeviceLink} needs from its edge. */
export interface DeviceLinkDependencies {
  readonly transports: TransportHost;
  /** Finds a profile by name; rejects when there is none. */
  readonly loadProfile: (name: string) => Promise<Profile>;
}

/** The connection to one adapter, opened and closed on request. */
export class DeviceLink {
  private current: (LinkSession & { readonly transport: Transport }) | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: DeviceLinkDependencies) {}

  /** The open connection, or `undefined`. */
  get session(): LinkSession | undefined {
    return this.current;
  }

  /**
   * Opens the adapter, initialises it and, with a profile, selects the profile's bus. With no profile the bus is left unselected: each legislated read selects it, as the `obd` command does.
   *
   * @throws LinkBusy when a connection is open already.
   * @throws TransportError, ElmError and ProfileError as the layers below do; nothing stays open after one.
   */
  connect(profileName: string | undefined, adapterUrl: string): Promise<LinkSession> {
    return this.exclusive(async () => {
      if (this.current !== undefined) {
        throw new LinkBusy(`already connected to ${this.current.adapterUrl}; disconnect first`);
      }
      return this.open(profileName, adapterUrl);
    });
  }

  /** Closes the connection. Does nothing when there is none. */
  disconnect(): Promise<void> {
    return this.exclusive(async () => {
      await this.close();
    });
  }

  /**
   * Closes the connection and opens it again with the same profile and adapter, for a link that dropped.
   *
   * @throws NotConnected when there is no connection to reopen.
   */
  reconnect(): Promise<LinkSession> {
    return this.exclusive(async () => {
      if (this.current === undefined) throw new NotConnected("there is no connection to reopen");
      const { profile, adapterUrl } = this.current;
      await this.close();
      return this.open(profile?.name, adapterUrl);
    });
  }

  /** Runs `work` once every earlier piece of work has finished, and holds the link until it settles. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs `work` with the open connection, exclusively.
   *
   * @throws NotConnected when there is no connection when its turn comes.
   */
  withSession<T>(work: (session: LinkSession) => Promise<T>): Promise<T> {
    return this.exclusive(() => {
      const session = this.current;
      if (session === undefined) throw new NotConnected("connect an adapter first");
      return work(session);
    });
  }

  private async open(profileName: string | undefined, adapterUrl: string): Promise<LinkSession> {
    const profile =
      profileName === undefined ? undefined : await this.dependencies.loadProfile(profileName);
    const transport = this.dependencies.transports.create(adapterUrl);
    await transport.open();
    try {
      const elm =
        profile?.bus.kind === "kline"
          ? new KLineElm(transport, { transcript: new Transcript() })
          : new Elm(transport, { transcript: new Transcript() });
      const adapter = await elm.initialise();
      if (profile !== undefined) await selectBus(elm, profile);
      this.current = { profile, adapterUrl, elm, adapter, transport };
      return this.current;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private async close(): Promise<void> {
    const open = this.current;
    this.current = undefined;
    await open?.transport.close();
  }
}
