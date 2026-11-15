/** A sweep of CAN request identifiers for a car with no profile, ending in a draft profile. */

import { NEGATIVE_RESPONSE, POSITIVE_OFFSET } from "./diag.js";
import { ElmError, NoResponse, type Elm } from "./elm.js";
import { DiagProtocol, permit } from "./guard.js";
import { jsonText, type JsonValue } from "./ordered-json.js";
import { OptionError } from "./options.js";
import { pythonRepr } from "./format.js";
import type { ProfileProtocol } from "./profile.js";
import type { LineSink } from "./unit-access.js";
import type { WritableSnapshotStore } from "./writes.js";

/** The default-session request each protocol's guard allows starts with this service byte. */
export const SESSION_SERVICE = 0x10;

/** The default-session sub-function each protocol's guard allows. */
export const DEFAULT_SESSION: Readonly<Record<ProfileProtocol, number>> = {
  [DiagProtocol.KWP2000]: 0x81,
  [DiagProtocol.UDS]: 0x01,
};

/** The highest 11-bit identifier. A 29-bit sweep would be too large to run blind. */
export const MAX_ID = 0x7ff;

const DRAFT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One request identifier that drew a reply to the session request, and who replied. */
export interface Found {
  readonly requestId: number;
  readonly responseId: number;
  /** Whether the unit accepted the session; a refusal still shows a unit is there. */
  readonly accepted: boolean;
  readonly detail: string;
}

/** What a sweep learned: units that answered, and identifiers that produced adapter errors. */
export interface Sweep {
  readonly found: Found[];
  readonly errors: Map<number, string>;
}

/** `0x`-prefixed lower-case hexadecimal, zero-padded to at least `digits` digits. */
function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, "0")}`;
}

/**
 * Picks out the replies that answer a session request.
 *
 * A reply counts only when it is a positive session response or a negative response to the session
 * service, so unrelated frames the adapter hears on the bus are ignored.
 */
export function interpret(
  replies: ReadonlyMap<number, readonly Uint8Array[]>,
  requestId: number,
): Found[] {
  const positive = SESSION_SERVICE + POSITIVE_OFFSET;
  const found: Found[] = [];
  for (const [sender, messages] of replies) {
    for (const message of messages) {
      const [service, refused, code] = message;
      if (service === positive) {
        found.push({ requestId, responseId: sender, accepted: true, detail: "session accepted" });
      } else if (
        service === NEGATIVE_RESPONSE &&
        message.length >= 3 &&
        refused === SESSION_SERVICE &&
        code !== undefined
      ) {
        found.push({
          requestId,
          responseId: sender,
          accepted: false,
          detail: `session refused (${code.toString(16).toUpperCase().padStart(2, "0")})`,
        });
      }
    }
  }
  return found;
}

/**
 * Sends a default-session request on every identifier from `first` to `last` inclusive.
 *
 * Only the guarded default or standard session request is sent, and the adapter accepts a reply
 * from any sender so the unit's own response identifier is learned, not assumed.
 *
 * @param progress Called with each identifier before it is tried.
 * @throws OptionError for an identifier range outside 11-bit CAN.
 * @throws GuardError when `session` is not a read-only session for `protocol`.
 */
export async function sweep(
  elm: Elm,
  protocol: ProfileProtocol,
  session: number,
  first: number,
  last: number,
  progress?: (requestId: number) => void,
): Promise<Sweep> {
  if (!(0 <= first && first <= last && last <= MAX_ID)) {
    throw new OptionError(
      `identifier range must lie within 0x000 to ${hex(MAX_ID, 1)}, first to last`,
    );
  }
  const request = await permit(protocol, Uint8Array.of(SESSION_SERVICE, session));
  const result: Sweep = { found: [], errors: new Map() };
  for (let requestId = first; requestId <= last; requestId++) {
    progress?.(requestId);
    const id = requestId.toString(16).toUpperCase().padStart(3, "0");
    await elm.require(`ATSH${id}`);
    await elm.require("ATAR");
    await elm.require(`ATFCSH${id}`);
    await elm.require("ATFCSD300000");
    await elm.require("ATFCSM1");
    try {
      result.found.push(...interpret(await elm.request(request), requestId));
    } catch (error) {
      if (error instanceof NoResponse) continue;
      if (!(error instanceof ElmError)) throw error;
      result.errors.set(requestId, error.message);
    }
  }
  return result;
}

/**
 * The text of a draft profile of the units that answered, marked unconfirmed.
 *
 * Units are named by request identifier because nothing in a session reply says what they are.
 *
 * @param today The date the draft is written, as `YYYY-MM-DD`.
 * @throws OptionError for a name that is not lower-case words joined by hyphens, or when two units
 * share a request or response identifier, which a profile cannot hold.
 */
export function draftProfile(
  found: readonly Found[],
  name: string,
  protocol: ProfileProtocol,
  session: number,
  bitrate: number,
  today: string,
): string {
  if (!DRAFT_NAME.test(name)) {
    throw new OptionError(
      `profile name ${pythonRepr(name)} must be lower-case words joined by hyphens`,
    );
  }
  const requests = found.map((item) => item.requestId);
  const responses = found.map((item) => item.responseId);
  if (new Set(requests).size !== requests.length || new Set(responses).size !== responses.length) {
    throw new OptionError(
      "more than one reply shares an identifier, so the units cannot be told apart; " +
        "build the profile by hand from the sweep output",
    );
  }
  const units = new Map<string, JsonValue>(
    found.map((item): [string, JsonValue] => [
      `unit-${item.requestId.toString(16).padStart(3, "0")}`,
      new Map<string, JsonValue>([
        ["description", `Unidentified unit that answered on ${hex(item.requestId, 3)}`],
        ["request", item.requestId],
        ["response", item.responseId],
        ["source", `obd-read discover sweep on ${today}: ${item.detail}`],
      ]),
    ]),
  );
  return `${jsonText(
    new Map<string, JsonValue>([
      [
        "notes",
        `Draft written by obd-read discover on ${today}. Every unit is a CAN identifier pair that answered a session request. Nothing says what the units are: rename them and fill in the descriptions before relying on this.`,
      ],
      ["name", name],
      ["description", "Draft from a discovery sweep"],
      ["status", "unconfirmed"],
      [
        "bus",
        new Map<string, JsonValue>([
          ["id_bits", 11],
          ["bitrate", bitrate],
        ]),
      ],
      [
        "diagnostics",
        new Map<string, JsonValue>([
          ["protocol", protocol],
          ["session", session],
        ]),
      ],
      ["units", units],
    ]),
  )}\n`;
}

/** What {@link discoverCommand} needs. */
export interface DiscoverOptions {
  readonly protocol: ProfileProtocol;
  /** The session sub-function to request. Default: the protocol's default session. */
  readonly session?: number;
  /** The CAN bit rate in bit/s. */
  readonly bitrate: number;
  /** The first request identifier to try. */
  readonly first: number;
  /** The last request identifier to try. */
  readonly last: number;
  /** The name of a new draft profile to write, if one is wanted. */
  readonly output?: string;
  /** The name the draft profile gives itself. */
  readonly name: string;
  /** Where the draft profile is created, refusing to replace a file. Needed with `output`. */
  readonly store?: WritableSnapshotStore;
  /** The date the draft is written, as `YYYY-MM-DD`. */
  readonly today: string;
}

/**
 * The discover command: sweeps the requested identifier range and reports, and optionally writes,
 * what answered.
 *
 * @returns 0 when at least one unit answered, 1 when none did.
 * @throws OptionError when the draft file already exists, the range or the draft name is bad, or
 * an output is named with no store, all before anything that changes the bus is sent where they can be.
 * @throws GuardError when the session is not a read-only one for the protocol.
 */
export async function discoverCommand(
  elm: Elm,
  options: DiscoverOptions,
  out: LineSink,
): Promise<number> {
  const { protocol, bitrate, first, last, output, store } = options;
  if (output !== undefined) {
    if (store === undefined) throw new OptionError("a draft profile needs somewhere to be written");
    if (await store.exists(output)) {
      throw new OptionError(`${output} already exists; choose a new file for the draft`);
    }
  }
  const session = options.session ?? DEFAULT_SESSION[protocol];
  await elm.selectCan(11, bitrate);
  out(
    `sweeping request identifiers ${hex(first, 3)} to ${hex(last, 3)} ` +
      `with ${protocol} session ${hex(session, 2)}; ` +
      "each silent identifier waits out the adapter's reply timeout",
  );
  const result = await sweep(elm, protocol, session, first, last);
  for (const item of result.found) {
    out(`request ${hex(item.requestId, 3)} -> response ${hex(item.responseId, 3)}: ${item.detail}`);
  }
  for (const [requestId, error] of result.errors) {
    out(`request ${hex(requestId, 3)}: adapter error: ${error}`);
  }
  out(`${String(result.found.length)} replies in ${String(last - first + 1)} identifiers`);
  if (output !== undefined && store !== undefined) {
    await store.create(
      output,
      draftProfile(result.found, options.name, protocol, session, bitrate, options.today),
    );
    out(`wrote draft profile ${output}; check it with: obd-read profile check ${output}`);
  }
  return result.found.length > 0 ? 0 : 1;
}
