/** One control unit's request and reply exchange, shared by KWP2000 and UDS. */

import { hexNumber, toHex } from "./bytes.js";
import { ElmError, type Elm } from "./elm.js";
import { permit, type DiagProtocol, type Token } from "./guard.js";

/** The service byte of a negative response. */
export const NEGATIVE_RESPONSE = 0x7f;
const RESPONSE_PENDING = 0x78;
/** What a unit adds to a request's service byte to make the service byte of its positive reply. */
export const POSITIVE_OFFSET = 0x40;

/** Negative response codes common to KWP2000 and UDS, for readable errors. */
export const RESPONSE_CODES: ReadonlyMap<number, string> = new Map([
  [0x10, "general reject"],
  [0x11, "service not supported"],
  [0x12, "sub-function not supported"],
  [0x13, "incorrect message length or format"],
  [0x21, "busy, repeat request"],
  [0x22, "conditions not correct"],
  [0x31, "request out of range"],
  [0x33, "security access denied"],
  [0x7e, "sub-function not supported in the active session"],
  [0x7f, "service not supported in the active session"],
  [0x80, "service not supported in the active session"],
]);

/** The control unit answered and refused the request. */
export class NegativeResponse extends Error {
  override name = "NegativeResponse";

  constructor(
    /** The service ID of the refused request. */
    readonly service: number,
    /** The negative response code. */
    readonly code: number,
  ) {
    const meaning = RESPONSE_CODES.get(code) ?? "manufacturer-specific or unlisted reason";
    super(`service ${hexNumber(service, 2)} refused with code ${hexNumber(code, 2)} (${meaning})`);
  }
}

/** One stored fault code with its status byte, exactly as the unit reported it. */
export interface Fault {
  /** The code bytes as upper-case hexadecimal. */
  readonly code: string;
  readonly status: number;
}

/** One identification value read from a unit. */
export class IdentField {
  constructor(
    readonly label: string,
    readonly raw: Uint8Array,
  ) {}

  /** The printable ASCII characters in the value, for part numbers and names. */
  get text(): string {
    return Array.from(this.raw)
      .filter((byte) => byte >= 0x20 && byte < 0x7f)
      .map((byte) => String.fromCharCode(byte))
      .join("")
      .trim();
  }
}

/** Requests to one addressed control unit, each passed through the guard. */
export class UnitSession {
  constructor(
    private readonly elm: Elm,
    readonly protocol: DiagProtocol,
    private readonly responseId: number,
  ) {}

  /**
   * Sends one request and returns the unit's positive reply, service byte first.
   *
   * @throws GuardError when the request is not allowed.
   * @throws NegativeResponse when the unit refuses it.
   * @throws NoResponse when the unit is silent.
   * @throws ElmError when the reply is unreadable or the unit asked for more time than the adapter
   * waited.
   */
  async request(payload: Uint8Array, token?: Token): Promise<Uint8Array> {
    const permitted = await permit(this.protocol, payload, token);
    const replies = await this.elm.request(permitted);
    const messages = replies.get(this.responseId);
    if (messages === undefined || messages.length === 0) {
      const senders = Array.from(replies.keys(), (canId) => hexNumber(canId, 1)).join(", ");
      throw new ElmError(
        `expected a reply from ${hexNumber(this.responseId, 1)}, got one from ${senders}`,
      );
    }
    const settled = messages.filter(
      (message) =>
        !(
          message.length >= 3 &&
          message[0] === NEGATIVE_RESPONSE &&
          message[2] === RESPONSE_PENDING
        ),
    );
    const message = settled.at(-1);
    if (message === undefined) {
      throw new ElmError(
        "the unit asked for more time and the adapter stopped listening before it answered",
      );
    }
    const [service, refusedService, code] = message;
    if (service === NEGATIVE_RESPONSE) {
      if (refusedService === undefined || code === undefined) {
        throw new ElmError(`short negative response: ${toHex(message)}`);
      }
      throw new NegativeResponse(refusedService, code);
    }
    if (service !== permitted.service + POSITIVE_OFFSET) {
      throw new ElmError(`reply ${toHex(message)} does not answer request ${toHex(payload)}`);
    }
    return message;
  }
}
