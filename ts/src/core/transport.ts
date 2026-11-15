/**
 * The link to an adapter: a byte pipe with a timeout on reads.
 *
 * This module is platform-free. Each platform entry point registers the transports it can build
 * with {@link registerTransport}, and callers open a link by adapter URL with {@link openTransport}.
 */

/** The link to the adapter could not be opened or failed in use. */
export class TransportError extends Error {
  override name = "TransportError";
}

/** No bytes arrived from the adapter within the allowed time. */
export class TransportTimeout extends TransportError {
  override name = "TransportTimeout";
}

/** An adapter URL that is malformed, names an unknown scheme or names no device. */
export class AdapterUrlError extends Error {
  override name = "AdapterUrlError";
}

/** A byte pipe to an ELM327-style adapter. */
export interface Transport {
  /** Connects to the adapter. Rejects with {@link TransportError} if it cannot be reached. */
  open(): Promise<void>;

  /** Releases the link. Resolves without error when the link never opened or is already closed. */
  close(): Promise<void>;

  /** Sends the bytes to the adapter. Rejects with {@link TransportError} if the link has failed. */
  write(data: Uint8Array): Promise<void>;

  /**
   * Returns the next bytes from the adapter, at least one.
   *
   * Rejects with {@link TransportTimeout} when nothing arrives within `timeoutMs` milliseconds, and
   * with {@link TransportError} if the link has failed. The chunking is arbitrary: a reply may be
   * split across reads.
   */
  read(timeoutMs: number): Promise<Uint8Array>;
}

/**
 * Every scheme an adapter URL may use.
 *
 * `ble`, `serial`, `tcp`, `socketcan` and `slcan` are served by the Node entry point. `webserial`,
 * `webbluetooth` and `webusb` are served by the browser entry point.
 */
export const SCHEMES = [
  "ble",
  "serial",
  "tcp",
  "socketcan",
  "slcan",
  "webserial",
  "webbluetooth",
  "webusb",
] as const;

/** One of {@link SCHEMES}. */
export type Scheme = (typeof SCHEMES)[number];

/**
 * A parsed adapter URL such as `ble://vLinker` or `tcp://192.168.80.1:35000`.
 *
 * `target` is never empty. `params` holds the query parameters with non-empty values, the last
 * occurrence of a repeated key winning.
 */
export interface AdapterAddress {
  readonly scheme: Scheme;
  readonly target: string;
  readonly params: ReadonlyMap<string, string>;
}

function isScheme(value: string): value is Scheme {
  return SCHEMES.some((scheme) => scheme === value);
}

/** Percent-decodes `text`, leaving any escape sequence that is not valid UTF-8 unchanged. */
function unquote(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const value = pair.slice(separator + 1);
    if (value === "") continue;
    params.set(
      unquote(pair.slice(0, separator).replaceAll("+", " ")),
      unquote(value.replaceAll("+", " ")),
    );
  }
  return params;
}

/**
 * Splits an adapter URL into scheme, target and query parameters.
 *
 * The target is the Bluetooth LE name or address, the serial device path, `host:port`, the
 * SocketCAN interface name, or the serial device an SLCAN adapter is on. For `webserial`,
 * `webbluetooth` and `webusb` the target is only a free label: the browser chooses the device in a
 * picker the user opens with a gesture, so the label names the adapter in the interface and in
 * saved records and selects nothing.
 *
 * Percent-escapes in the target and parameters are decoded, and `+` in a parameter is a space.
 *
 * @throws AdapterUrlError for an unknown scheme or an empty target.
 */
export function parseAdapterUrl(url: string): AdapterAddress {
  const separator = url.indexOf("://");
  const scheme = separator < 0 ? "" : url.slice(0, separator);
  if (!isScheme(scheme)) {
    throw new AdapterUrlError(
      `adapter URL must start with one of ${SCHEMES.join(", ")}://, got ${JSON.stringify(url)}`,
    );
  }
  const rest = url.slice(separator + 3);
  const queryStart = rest.indexOf("?");
  const rawTarget = queryStart < 0 ? rest : rest.slice(0, queryStart);
  const query = queryStart < 0 ? "" : rest.slice(queryStart + 1);
  const target = unquote(rawTarget);
  if (target === "") {
    throw new AdapterUrlError(`adapter URL ${JSON.stringify(url)} names no device`);
  }
  return { scheme, target, params: parseQuery(query) };
}

/** Builds the unopened {@link Transport} for an address. May throw {@link AdapterUrlError}. */
export type TransportFactory = (address: AdapterAddress) => Transport;

const factories = new Map<Scheme, TransportFactory>();

/**
 * Makes `factory` the builder of transports for `scheme`. Platform entry points call this.
 *
 * Returns a function that removes the registration again.
 *
 * @throws Error if the scheme already has a factory.
 */
export function registerTransport(scheme: Scheme, factory: TransportFactory): () => void {
  if (factories.has(scheme)) {
    throw new Error(`a transport is already registered for ${scheme}://`);
  }
  factories.set(scheme, factory);
  return () => {
    if (factories.get(scheme) === factory) factories.delete(scheme);
  };
}

/** The schemes that have a registered transport factory in this runtime, in registration order. */
export function registeredSchemes(): Scheme[] {
  return [...factories.keys()];
}

/**
 * Builds the transport an adapter URL names. The link is not opened yet.
 *
 * @throws AdapterUrlError if the URL is malformed or the factory rejects its target.
 * @throws TransportError if no entry point has registered a transport for the scheme.
 */
export function openTransport(url: string): Transport {
  const address = parseAdapterUrl(url);
  const factory = factories.get(address.scheme);
  if (factory === undefined) {
    throw new TransportError(
      `no transport is registered for ${address.scheme}:// (import the entry point for this platform)`,
    );
  }
  return factory(address);
}
