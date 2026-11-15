/**
 * The single gate every diagnostic request passes before it reaches a car.
 *
 * Requests that only read are allowed. Three services that change the car each have one route, and
 * each route needs a token that only this module issues, after the safeguards that route depends on
 * have run:
 *
 * - clearing fault codes needs a {@link ClearToken}, proof that what is about to be erased is saved;
 * - a coding or adaptation write needs a {@link WriteToken}, bound to the exact request bytes and to
 *   a saved snapshot that records that request and the value it replaces;
 * - an actuator test needs an {@link ActuationTokens} pair, bound to the exact start request and the
 *   request that hands control back to the unit.
 *
 * Write and actuation tokens pass one request each and then are spent. Security access, resets,
 * routine control, programming sessions, data transfer and every service not listed here are
 * refused, with or without a token: there is no setting that turns this off.
 *
 * Sources for the request layouts: ISO/DIS 14230-3 draft of 16 December 1996 (KWP2000), tables
 * 7.1.2.1, 7.5.2.1 and 9.1.2.1; python-udsoncan's InputOutputControlByIdentifier and
 * WriteDataByIdentifier services (UDS, ISO 14229-1).
 */

import { bytesEqual, hexNumber, toUpperHex } from "./bytes.js";

/** The diagnostic protocol a request belongs to. */
export const DiagProtocol = {
  KWP2000: "kwp2000",
  UDS: "uds",
  OBD: "obd",
} as const;

/** One of the {@link DiagProtocol} values. */
export type DiagProtocol = (typeof DiagProtocol)[keyof typeof DiagProtocol];

/** Every {@link DiagProtocol} value. */
export const DIAG_PROTOCOLS: readonly DiagProtocol[] = Object.values(DiagProtocol);

/** A request was refused because it could change something on the car. */
export class GuardError extends Error {
  override name = "GuardError";
}

/**
 * Where the guard looks for the snapshot files its tokens depend on. A platform supplies the
 * implementation (the filesystem on Node, browser storage in a page); a snapshot is named by an
 * opaque string.
 */
export interface SnapshotStore {
  /** Whether a snapshot exists under this name. */
  exists(snapshot: string): Promise<boolean>;
  /** The size of the snapshot in bytes. Rejects if there is none. */
  size(snapshot: string): Promise<number>;
  /** The snapshot's contents as UTF-8 text. Rejects if there is none or it cannot be read. */
  readText(snapshot: string): Promise<string>;
}

/**
 * Service IDs that only read, per protocol. A value of `null` allows every sub-function; a set
 * allows only the listed first parameter bytes.
 */
export const READ_ONLY: Readonly<
  Record<DiagProtocol, ReadonlyMap<number, ReadonlySet<number> | null>>
> = {
  [DiagProtocol.KWP2000]: new Map([
    [0x10, new Set([0x81, 0x92])], // default session, standard diagnostic session
    [0x12, null], // read freeze frame data
    [0x17, null], // read status of fault codes
    [0x18, null], // read fault codes by status
    [0x1a, null], // read ECU identification
    [0x21, null], // read data by local identifier
    [0x3e, null], // tester present
  ]),
  [DiagProtocol.UDS]: new Map([
    [0x10, new Set([0x01, 0x03])], // default session, extended diagnostic session
    [0x19, null], // read fault code information
    [0x22, null], // read data by identifier
    [0x3e, null], // tester present
  ]),
  [DiagProtocol.OBD]: new Map([
    [0x01, null], // current data
    [0x02, null], // freeze frame data
    [0x03, null], // stored fault codes
    [0x06, null], // on-board monitoring results
    [0x07, null], // pending fault codes
    [0x09, null], // vehicle information
    [0x0a, null], // permanent fault codes
  ]),
};

/** The service that clears stored fault codes, per protocol. */
export const CLEAR_SERVICE: Readonly<Record<DiagProtocol, number>> = {
  [DiagProtocol.KWP2000]: 0x14,
  [DiagProtocol.UDS]: 0x14,
  [DiagProtocol.OBD]: 0x04,
};

/**
 * The service that writes a value by identifier, per protocol: KWP2000 writeDataByLocalIdentifier,
 * UDS writeDataByIdentifier. OBD has none.
 */
export const WRITE_SERVICE: ReadonlyMap<DiagProtocol, number> = new Map([
  [DiagProtocol.KWP2000, 0x3b],
  [DiagProtocol.UDS, 0x2e],
]);

/**
 * The service that reads the value a write replaces, per protocol: readDataByLocalIdentifier and
 * readDataByIdentifier. OBD has none.
 */
export const READ_SERVICE: ReadonlyMap<DiagProtocol, number> = new Map([
  [DiagProtocol.KWP2000, 0x21],
  [DiagProtocol.UDS, 0x22],
]);

/**
 * The service that takes control of an input or output, per protocol: KWP2000
 * inputOutputControlByLocalIdentifier, UDS inputOutputControlByIdentifier. OBD has none.
 */
export const ACTUATION_SERVICE: ReadonlyMap<DiagProtocol, number> = new Map([
  [DiagProtocol.KWP2000, 0x30],
  [DiagProtocol.UDS, 0x2f],
]);

/**
 * Bytes of identifier after the service byte in a read, write or actuation request: a KWP2000
 * local identifier is one byte, a UDS data identifier two. OBD has none.
 */
export const IDENTIFIER_LENGTH: ReadonlyMap<DiagProtocol, number> = new Map([
  [DiagProtocol.KWP2000, 1],
  [DiagProtocol.UDS, 2],
]);

/**
 * The longest an actuator test may hold control, in milliseconds. An output driven for longer than
 * its normal duty can overheat a coil or motor or hold a part at its end stop; a test that needs
 * longer is run again, after the user has seen the first one end.
 */
export const ACTUATION_MAX_MS = 30_000;

/** UDS sets bit 7 of a sub-function to suppress the positive reply; it is not part of the value. */
const UDS_SUPPRESS_REPLY = 0x80;

const PERMIT_KEY = Symbol("permit");
const TOKEN_KEY = Symbol("token");

/**
 * Proof that a snapshot of the codes about to be erased is on disk. Issued only by
 * {@link authoriseClear}; constructing one directly throws {@link GuardError}.
 */
export class ClearToken {
  /**
   * @param key Held only by this module.
   * @throws GuardError unless `key` is the guard's own.
   */
  constructor(
    key: unknown,
    readonly store: SnapshotStore,
    readonly snapshot: string,
  ) {
    if (key !== TOKEN_KEY) throw new GuardError("a clear token is issued only by the guard");
  }
}

/**
 * Returns a token for one clear request, once the snapshot exists and has content.
 *
 * @throws GuardError when the snapshot is missing or empty.
 */
export async function authoriseClear(store: SnapshotStore, snapshot: string): Promise<ClearToken> {
  if (!(await store.exists(snapshot)) || (await store.size(snapshot)) === 0) {
    throw new GuardError(`no saved snapshot at ${snapshot}; refusing to clear`);
  }
  return new ClearToken(TOKEN_KEY, store, snapshot);
}

/**
 * The identifier bytes that follow the service byte in a read, write or actuation request.
 *
 * @throws GuardError when the protocol has no identifier-addressed services or the request is too
 * short to carry one.
 */
export function identifier(protocol: DiagProtocol, payload: Uint8Array): Uint8Array {
  const length = IDENTIFIER_LENGTH.get(protocol);
  if (length === undefined) {
    throw new GuardError(`${protocol} has no identifier-addressed services`);
  }
  if (payload.length < 1 + length) {
    throw new GuardError(`request ${toUpperHex(payload)} is too short to carry an identifier`);
  }
  return payload.slice(1, 1 + length);
}

/** A token that passes one exact request once, then is spent. */
abstract class SingleUseToken {
  readonly protocol: DiagProtocol;
  readonly payload: Uint8Array;
  private used = false;

  /** @throws GuardError unless `key` is the guard's own. */
  constructor(key: unknown, protocol: DiagProtocol, payload: Uint8Array) {
    if (key !== TOKEN_KEY) {
      throw new GuardError("write and actuation tokens are issued only by the guard");
    }
    this.protocol = protocol;
    this.payload = payload.slice();
  }

  /** Whether the token has passed its request. */
  get spent(): boolean {
    return this.used;
  }

  /** Rejects with GuardError when a condition beyond the request bytes no longer holds. */
  protected abstract check(): Promise<void>;

  /**
   * Marks the token used for this request.
   *
   * @throws GuardError unless it is the request the token was issued for and the token is unspent,
   * or a condition the token depends on no longer holds. A refused request leaves it unspent.
   */
  async spend(protocol: DiagProtocol, payload: Uint8Array): Promise<void> {
    if (this.used) {
      throw new GuardError("this token has already been used; each one passes a single request");
    }
    if (protocol !== this.protocol || !bytesEqual(payload, this.payload)) {
      throw new GuardError(
        `a token for ${this.protocol} request ${toUpperHex(this.payload)} cannot ` +
          `authorise ${protocol} request ${toUpperHex(payload)}`,
      );
    }
    // Claimed before the await, so a concurrent permit cannot spend the same token twice.
    this.used = true;
    try {
      await this.check();
    } catch (error) {
      this.used = false;
      throw error;
    }
  }
}

/**
 * Proof that a snapshot recording this write request and the value it replaces is on disk. Passes
 * the one request it was issued for, once. Issued only by {@link authoriseWrite}.
 */
export class WriteToken extends SingleUseToken {
  /** @throws GuardError unless `key` is the guard's own. */
  constructor(
    key: unknown,
    protocol: DiagProtocol,
    payload: Uint8Array,
    readonly store: SnapshotStore,
    readonly snapshot: string,
  ) {
    super(key, protocol, payload);
  }

  protected override async check(): Promise<void> {
    if (!(await this.store.exists(this.snapshot))) {
      throw new GuardError(`snapshot ${this.snapshot} has gone; refusing to write`);
    }
  }
}

/**
 * Leave to send one actuation request, issued only as half of an {@link ActuationTokens} pair.
 */
export class ActuatorToken extends SingleUseToken {
  protected override check(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The start request of one actuator test and the request that hands control back, each passable
 * once.
 */
export interface ActuationTokens {
  readonly start: ActuatorToken;
  readonly stop: ActuatorToken;
}

/** A token that {@link permit} accepts. */
export type Token = ClearToken | WriteToken | ActuatorToken;

/**
 * Returns a token for one write request, once its snapshot is saved.
 *
 * The snapshot must be a JSON object whose `write_request` is this request in upper-case
 * hexadecimal and whose `previous_value` is the hexadecimal value read before it.
 *
 * @throws GuardError when the request is not the protocol's write service, carries no value after
 * its identifier, or the snapshot is missing, unreadable or for another request.
 */
export async function authoriseWrite(
  store: SnapshotStore,
  snapshot: string,
  protocol: DiagProtocol,
  payload: Uint8Array,
): Promise<WriteToken> {
  const service = WRITE_SERVICE.get(protocol);
  if (service === undefined || payload[0] !== service) {
    throw new GuardError(
      `${payload.length === 0 ? "empty request" : toUpperHex(payload)} is not a ${protocol} write`,
    );
  }
  if (payload.length <= 1 + identifier(protocol, payload).length) {
    throw new GuardError(`write ${toUpperHex(payload)} carries no value to write`);
  }
  let saved: unknown;
  try {
    saved = JSON.parse(await store.readText(snapshot));
  } catch (error) {
    throw new GuardError(`no readable snapshot at ${snapshot}; refusing to write`, {
      cause: error,
    });
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    throw new GuardError(`snapshot ${snapshot} is not a write snapshot; refusing to write`);
  }
  if (!("write_request" in saved) || saved.write_request !== toUpperHex(payload)) {
    throw new GuardError(`snapshot ${snapshot} does not record request ${toUpperHex(payload)}`);
  }
  if (!("previous_value" in saved) || typeof saved.previous_value !== "string") {
    throw new GuardError(`snapshot ${snapshot} records no previous value; refusing to write`);
  }
  return new WriteToken(TOKEN_KEY, protocol, payload, store, snapshot);
}

/**
 * Refuses an actuator test that no token would be issued for, before anything is sent.
 *
 * @throws GuardError when either request is not the protocol's actuation service, the stop request
 * names a different identifier from the start, the two are the same request, or `durationMs` is not
 * above zero and at most {@link ACTUATION_MAX_MS}.
 */
export function checkActuation(
  protocol: DiagProtocol,
  start: Uint8Array,
  stop: Uint8Array,
  durationMs: number,
): void {
  const service = ACTUATION_SERVICE.get(protocol);
  for (const [label, payload] of [
    ["start", start],
    ["stop", stop],
  ] as const) {
    if (service === undefined || payload[0] !== service) {
      throw new GuardError(
        `${label} request ${payload.length === 0 ? "(empty)" : toUpperHex(payload)} is not a ` +
          `${protocol} actuation request`,
      );
    }
  }
  if (!bytesEqual(identifier(protocol, start), identifier(protocol, stop))) {
    throw new GuardError("the stop request must name the same identifier as the start request");
  }
  if (bytesEqual(start, stop)) {
    throw new GuardError("the stop request is the same as the start request");
  }
  if (!(durationMs > 0 && durationMs <= ACTUATION_MAX_MS)) {
    throw new GuardError(
      `an actuator test lasts more than 0 and at most ${String(ACTUATION_MAX_MS / 1000)} seconds`,
    );
  }
}

/**
 * Returns the start and stop tokens for one actuator test that {@link checkActuation} passes.
 *
 * @throws GuardError as {@link checkActuation} does.
 */
export function authoriseActuation(
  protocol: DiagProtocol,
  start: Uint8Array,
  stop: Uint8Array,
  durationMs: number,
): ActuationTokens {
  checkActuation(protocol, start, stop, durationMs);
  return {
    start: new ActuatorToken(TOKEN_KEY, protocol, start),
    stop: new ActuatorToken(TOKEN_KEY, protocol, stop),
  };
}

/** A request the guard has passed. The adapter layer sends nothing else. */
export class Permit {
  readonly protocol: DiagProtocol;
  /** The request bytes, service byte first. */
  readonly payload: Uint8Array;
  /** The first byte of {@link payload}. */
  readonly service: number;

  /**
   * @param key Held only by this module.
   * @throws GuardError unless `key` is the guard's own.
   */
  constructor(key: unknown, protocol: DiagProtocol, payload: Uint8Array, service: number) {
    if (key !== PERMIT_KEY) throw new GuardError("a Permit is issued only by permit()");
    this.protocol = protocol;
    this.payload = payload.slice();
    this.service = service;
  }
}

/**
 * Passes or refuses one request.
 *
 * Read-only services pass. The clear service passes only with a {@link ClearToken}, and a clear
 * token passes nothing but the clear service. A write or actuation request passes only with an
 * unspent token issued for exactly that request, which it spends.
 *
 * @throws GuardError for everything else.
 */
export async function permit(
  protocol: DiagProtocol,
  payload: Uint8Array,
  token?: Token,
): Promise<Permit> {
  const service = payload[0];
  if (service === undefined) throw new GuardError("empty request");
  if (token instanceof WriteToken || token instanceof ActuatorToken) {
    await token.spend(protocol, payload);
    return new Permit(PERMIT_KEY, protocol, payload, service);
  }
  if (token !== undefined) {
    if (service !== CLEAR_SERVICE[protocol]) {
      throw new GuardError(`a clear token cannot authorise service ${hexNumber(service, 2)}`);
    }
    if (!(await token.store.exists(token.snapshot))) {
      throw new GuardError(`snapshot ${token.snapshot} has gone; refusing to clear`);
    }
    return new Permit(PERMIT_KEY, protocol, payload, service);
  }

  const allowed = READ_ONLY[protocol];
  const subFunctions = allowed.get(service);
  if (subFunctions === undefined) {
    let reason: string;
    if (service === CLEAR_SERVICE[protocol]) {
      reason = "clearing fault codes goes through the clear command";
    } else if (service === WRITE_SERVICE.get(protocol)) {
      reason = "writes go through the write command";
    } else if (service === ACTUATION_SERVICE.get(protocol)) {
      reason = "actuator tests go through the actuate command";
    } else {
      reason = "it is not a read-only service";
    }
    throw new GuardError(`${protocol} service ${hexNumber(service, 2)} refused: ${reason}`);
  }
  if (subFunctions !== null) {
    const first = payload[1];
    if (first === undefined) {
      throw new GuardError(`${protocol} service ${hexNumber(service, 2)} needs a sub-function`);
    }
    const value = protocol === DiagProtocol.UDS ? first & ~UDS_SUPPRESS_REPLY : first;
    if (!subFunctions.has(value)) {
      throw new GuardError(
        `${protocol} service ${hexNumber(service, 2)} sub-function ${hexNumber(first, 2)} ` +
          "refused: only default and standard diagnostic sessions are allowed",
      );
    }
  }
  return new Permit(PERMIT_KEY, protocol, payload, service);
}
