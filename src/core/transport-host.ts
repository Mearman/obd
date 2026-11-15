/**
 * Where a service gets its transports from.
 *
 * A {@link TransportHost} builds the unopened {@link Transport} for an adapter URL. The service never calls the global registry directly, so the same service runs where every scheme is local (Node), where some schemes live in another context (a dedicated worker whose Web Bluetooth transport stays on the page, see `service/transport-link.ts`) and against the simulator.
 *
 * This module is platform-free.
 */

import type { DeviceGrant } from "./service.js";
import {
  SCHEMES,
  openTransport,
  registeredSchemes,
  TransportError,
  type Scheme,
  type Transport,
} from "./transport.js";

/** Builds the transports an adapter URL names. */
export interface TransportHost {
  /** The adapter schemes this host serves, for the capability listing. */
  schemes(): readonly Scheme[];

  /** Whether {@link create} builds a transport for this URL. Never throws. */
  serves(adapterUrl: string): boolean;

  /**
   * Builds the unopened transport for `adapterUrl`.
   *
   * @throws TransportError when the host does not serve the URL.
   * @throws AdapterUrlError when the URL is malformed.
   */
  create(adapterUrl: string): Transport;
}

/** The text before `://` in an adapter URL, or the empty string when there is none. */
export function schemeOf(adapterUrl: string): string {
  const separator = adapterUrl.indexOf("://");
  return separator < 0 ? "" : adapterUrl.slice(0, separator);
}

function isScheme(value: string): value is Scheme {
  return SCHEMES.some((scheme) => scheme === value);
}

/** The host over the transports this runtime registered with `registerTransport`. */
export function registryTransportHost(): TransportHost {
  return {
    schemes: () => registeredSchemes(),
    serves: (adapterUrl) => {
      const scheme = schemeOf(adapterUrl);
      return isScheme(scheme) && registeredSchemes().includes(scheme);
    },
    create: (adapterUrl) => openTransport(adapterUrl),
  };
}

/** A host that serves exactly `schemes` by calling `build`, whatever else is registered. */
export function schemeTransportHost(
  schemes: readonly Scheme[],
  build: (adapterUrl: string) => Transport,
): TransportHost {
  const served = new Set<string>(schemes);
  return {
    schemes: () => schemes,
    serves: (adapterUrl) => served.has(schemeOf(adapterUrl)),
    create: (adapterUrl) => {
      if (!served.has(schemeOf(adapterUrl))) {
        throw new TransportError(`this host does not serve ${JSON.stringify(adapterUrl)}`);
      }
      return build(adapterUrl);
    },
  };
}

/**
 * One host over several: a URL goes to the first host that serves it, and a scheme is listed once.
 *
 * Order matters only when two hosts serve the same URL.
 */
export function composeTransportHosts(...hosts: readonly TransportHost[]): TransportHost {
  return {
    schemes: () => [...new Set(hosts.flatMap((host) => host.schemes()))],
    serves: (adapterUrl) => hosts.some((host) => host.serves(adapterUrl)),
    create: (adapterUrl) => {
      const host = hosts.find((candidate) => candidate.serves(adapterUrl));
      if (host === undefined) {
        throw new TransportError(`no transport host serves ${JSON.stringify(adapterUrl)}`);
      }
      return host.create(adapterUrl);
    },
  };
}

/**
 * The devices a page's picker granted, by scheme, for a transport that runs where no picker can.
 *
 * Web Serial and WebUSB ask the user in a prompt that needs a user gesture on the page. A dedicated worker has the APIs but no page, so the page runs the picker and hands the worker a description of the grant; the worker's transport then picks that device from the browser's list of granted ones.
 */
export class DeviceGrants {
  private readonly byScheme = new Map<Scheme, DeviceGrant>();

  /** Remembers the grant, replacing the scheme's earlier one. */
  grant(grant: DeviceGrant): void {
    this.byScheme.set(grant.scheme, grant);
  }

  /** The latest grant for the scheme, or `undefined` when the page has granted none. */
  granted(scheme: Scheme): DeviceGrant | undefined {
    return this.byScheme.get(scheme);
  }
}
