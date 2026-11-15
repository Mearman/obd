/**
 * One diagnostic request and what came back, as the adapter session saw it: the raw material a capture is made of.
 *
 * An exchange records the bus and the addressing in force when the request was sent, the request bytes, and the outcome: every reply message by sender exactly as reassembled, or the failure the adapter or the link reported. A negative response is a reply like any other (`7F`, the refused service, the code), so nothing is interpreted when an exchange is recorded. The schemas here are the single definition of that shape; the types are derived from them. This module is platform-free.
 */

import { z } from "zod";
import { DIAG_PROTOCOLS } from "./guard.js";
import { KLINE_SCHEME_NAMES } from "./profile.js";

/** The longest diagnostic message ISO 15765-2 carries, in bytes; no request or reply message is longer. */
export const MAX_MESSAGE_BYTES = 4095;

/** The most senders one exchange may record replies from. */
export const MAX_SENDERS = 64;

/** The most messages one sender may give to one request (a unit that asks for more time sends several). */
export const MAX_MESSAGES_PER_SENDER = 64;

/** The longest error text an exchange keeps. */
export const MAX_ERROR_TEXT = 1000;

/** The widest CAN identifier: 29 bits. */
const MAX_CAN_ID = 0x1fffffff;

const canId = z.int().min(0).max(MAX_CAN_ID);
const byte = z.int().min(0).max(0xff);

/** Upper-case hexadecimal bytes, at most {@link MAX_MESSAGE_BYTES} of them. */
const hexBytes = (minimum: number) =>
  z
    .string()
    .max(2 * MAX_MESSAGE_BYTES)
    .regex(/^(?:[0-9A-F]{2})*$/, "upper-case hexadecimal bytes")
    .refine((text) => text.length >= 2 * minimum, { error: `at least ${String(minimum)} byte` });

/**
 * The bus a request went out on, or `null` when the session had not selected one (an imported transcript that never set the protocol).
 *
 * `bitrate` is `null` when the rate is not known, as for a transcript whose adapter chose the protocol itself.
 */
export const exchangeBusSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("can"),
      idBits: z.literal([11, 29]),
      bitrate: z.int().positive().max(10_000_000).nullable(),
    }),
    z.strictObject({
      kind: z.literal("kline"),
      scheme: z.enum(KLINE_SCHEME_NAMES),
      tester: byte,
      headerFormat: byte,
    }),
  ])
  .nullable();

/** The bus a request went out on. */
export type ExchangeBus = z.output<typeof exchangeBusSchema>;

/**
 * Who a request was sent to and whose replies the adapter passed, or `null` when the session had not addressed anything yet.
 *
 * - `functional`: broadcast to every emissions-related unit on `requestId` (`null` on K-line, where the adapter's default header addresses them), every reply passed.
 * - `physical`: one unit at `requestId`, replies passed only from `responseId` (`null` on K-line, where the adapter filters nothing), with the ISO 15765-2 extended address the unit is reached with, or `null`.
 * - `any-reply`: sent to `requestId` with every reply passed, as a discovery sweep does to learn who answers.
 */
export const exchangeAddressSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("functional"), requestId: canId.nullable() }),
    z.strictObject({
      mode: z.literal("physical"),
      requestId: canId,
      responseId: canId.nullable(),
      extendedAddress: byte.nullable(),
    }),
    z.strictObject({ mode: z.literal("any-reply"), requestId: canId }),
  ])
  .nullable();

/** Who a request was sent to. */
export type ExchangeAddress = z.output<typeof exchangeAddressSchema>;

const errorText = z.string().max(MAX_ERROR_TEXT);

/**
 * What came back from one request.
 *
 * - `replies`: each sender's messages in the order the adapter reassembled them, senders in the order each first answered. A negative response is one of these messages.
 * - `no-response`: the adapter reported that no unit answered, with its message.
 * - `adapter-error`: the adapter reported an error, did not understand the request or sent something unreadable; `error` names the session's error class.
 * - `transport-error`: the link to the adapter failed or timed out.
 */
export const exchangeOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("replies"),
    replies: z
      .array(
        z.strictObject({
          sender: canId,
          messages: z.array(hexBytes(0)).min(1).max(MAX_MESSAGES_PER_SENDER),
        }),
      )
      .min(1)
      .max(MAX_SENDERS),
  }),
  z.strictObject({ kind: z.literal("no-response"), message: errorText }),
  z.strictObject({
    kind: z.literal("adapter-error"),
    error: z.enum(["ElmError", "AdapterUnsupported"]),
    message: errorText,
  }),
  z.strictObject({
    kind: z.literal("transport-error"),
    error: z.enum(["TransportError", "TransportTimeout"]),
    message: errorText,
  }),
]);

/** What came back from one request. */
export type ExchangeOutcome = z.output<typeof exchangeOutcomeSchema>;

/** A time as integer milliseconds since the Unix epoch. */
export const timestampSchema = z.int().min(0);

/**
 * One request and its outcome.
 *
 * `seq` orders the exchanges of a capture and never repeats; `at` is when the request was sent. `session` is the index of the adapter session (adapter and tool) it belongs to. `protocol` is the protocol the guard passed it under, or `null` when it is not known (an imported transcript records only bytes).
 */
export const exchangeSchema = z.strictObject({
  seq: z.int().min(0),
  at: timestampSchema,
  session: z.int().min(0),
  bus: exchangeBusSchema,
  address: exchangeAddressSchema,
  protocol: z.enum(DIAG_PROTOCOLS).nullable(),
  request: hexBytes(1),
  outcome: exchangeOutcomeSchema,
});

/** One request and its outcome. */
export type Exchange = z.output<typeof exchangeSchema>;

/** Whether two recorded buses can be the same bus: the same kind and width, and the same rate unless one is not known. */
export function busesCompatible(first: ExchangeBus, second: ExchangeBus): boolean {
  if (first === null || second === null) return true;
  if (first.kind === "can" && second.kind === "can") {
    return (
      first.idBits === second.idBits &&
      (first.bitrate === null || second.bitrate === null || first.bitrate === second.bitrate)
    );
  }
  if (first.kind === "kline" && second.kind === "kline") return first.scheme === second.scheme;
  return false;
}

/** A stable text key for an address, equal for two addresses exactly when they address the same thing. */
export function addressKey(address: ExchangeAddress): string {
  if (address === null) return "unaddressed";
  switch (address.mode) {
    case "functional":
      return `functional:${String(address.requestId)}`;
    case "physical":
      return `physical:${String(address.requestId)}:${String(address.responseId)}:${String(address.extendedAddress)}`;
    case "any-reply":
      return `any-reply:${String(address.requestId)}`;
  }
}

/** How an address reads in a report: `7E0 -> 7E8`, `functional 7DF`, `7E0 -> any`, with an extended address as `6F1 (40) -> 640`. */
export function describeAddress(address: ExchangeAddress): string {
  const id = (value: number | null): string =>
    value === null ? "default" : value.toString(16).toUpperCase().padStart(3, "0");
  if (address === null) return "unaddressed";
  switch (address.mode) {
    case "functional":
      return `functional ${id(address.requestId)}`;
    case "physical": {
      const extended =
        address.extendedAddress === null
          ? ""
          : ` (${address.extendedAddress.toString(16).toUpperCase().padStart(2, "0")})`;
      return `${id(address.requestId)}${extended} -> ${address.responseId === null ? "any" : id(address.responseId)}`;
    }
    case "any-reply":
      return `${id(address.requestId)} -> any`;
  }
}
