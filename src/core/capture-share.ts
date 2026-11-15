/**
 * A capture as the data of a share link, and removing what identifies the car from its raw bytes.
 *
 * A shared capture is the capture document itself, so the person who opens the link decodes it with whichever profile they choose. It never carries the adapter's address. Redaction works on the raw replies, since a capture holds no decoded value: the data bytes of every reply to a request that reads the VIN, a calibration identifier or a serial number are overwritten, and every other copy of those values, or any VIN-shaped run of ASCII, in any request, reply or text is overwritten too. Overwritten bytes become `*` (0x2A), so each message keeps its length and still decodes, to a value of asterisks. This module is platform-free.
 */

import { z } from "zod";
import { captureSchema, type Capture } from "./capture.js";
import type { Exchange } from "./exchange.js";
import {
  asciiOfHex,
  hexOfAscii,
  isIdentifyingLabel,
  scrub,
  secretSpellings,
  vinsIn,
} from "./identifying.js";
import { INFO_CALIBRATION_ID } from "./legislated.js";
import { INFO_VIN, VEHICLE_INFORMATION } from "./obd.js";
import { IDENT_FIELDS } from "./uds.js";

/** The byte redaction writes over an identifying byte: ASCII `*`. */
export const REDACTED_BYTE = 0x2a;

const REDACTED_HEX = REDACTED_BYTE.toString(16).toUpperCase();

/** A positive reply is the request's service plus this. */
const POSITIVE_OFFSET = 0x40;

/** Where the data of an identifying reply starts: after the service byte and the two bytes naming what was read (a mode 09 identifier and its count, or a UDS data identifier). */
const FIELD_START = 3;

function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * The requests whose replies carry an identifying value, as upper-case hexadecimal, with the prefix of their positive reply: mode 09 VIN and calibration identifiers, and the UDS identification identifiers whose label {@link isIdentifyingLabel} names.
 */
const IDENTIFYING_READS: readonly { readonly request: string; readonly reply: string }[] = [
  ...[INFO_VIN, INFO_CALIBRATION_ID].map((info) => ({
    request: `${hexByte(VEHICLE_INFORMATION)}${hexByte(info)}`,
    reply: `${hexByte(VEHICLE_INFORMATION + POSITIVE_OFFSET)}${hexByte(info)}`,
  })),
  ...[...IDENT_FIELDS]
    .filter(([, label]) => isIdentifyingLabel(label))
    .map(([identifier]) => {
      const did = identifier.toString(16).toUpperCase().padStart(4, "0");
      return { request: `22${did}`, reply: `62${did}` };
    }),
];

/** The data of a `capture` link: the capture document with no adapter address, and whether its identifying bytes were overwritten. */
export const captureShareSchema = z.strictObject({
  /** Whether the VIN, calibration identifiers and serial numbers were overwritten before the link was written. */
  redacted: z.boolean(),
  capture: captureSchema.refine(
    (capture) => capture.sessions.every((session) => session.adapter.url === null),
    "a shared capture never carries the adapter's address",
  ),
});

/** What one shared capture carries. */
export type CaptureShareData = z.output<typeof captureShareSchema>;

/** Whether a reply message to `request` is a positive reply that carries an identifying value. */
function identifyingField(request: string, message: string): boolean {
  return IDENTIFYING_READS.some(
    (read) =>
      request === read.request &&
      message.startsWith(read.reply) &&
      message.length > 2 * FIELD_START,
  );
}

/** The printable text of hexadecimal bytes, without redaction's asterisks and the blanks around it. */
function fieldText(hex: string): string {
  return asciiOfHex(hex).replaceAll("\u0000", "").replaceAll("*", "").trim();
}

function replyMessages(exchange: Exchange): readonly string[] {
  return exchange.outcome.kind === "replies"
    ? exchange.outcome.replies.flatMap((reply) => reply.messages)
    : [];
}

/** The texts of a capture a person or a program wrote, rather than an adapter sent as bytes. */
function captureTexts(capture: Capture): string[] {
  const texts = [...capture.notes, capture.origin.description];
  for (const exchange of capture.exchanges) {
    if (exchange.outcome.kind !== "replies") texts.push(exchange.outcome.message);
  }
  return texts;
}

/**
 * Every value in a capture that identifies the car or a unit: the data of each reply that reads the VIN, a calibration identifier or a serial number (as printable text, when at least four characters), and every VIN-shaped word in the ASCII of any request or reply or in the capture's texts.
 */
export function captureIdentifyingValues(capture: Capture): string[] {
  const found = new Set<string>();
  for (const exchange of capture.exchanges) {
    for (const message of replyMessages(exchange)) {
      if (identifyingField(exchange.request, message)) {
        const text = fieldText(message.slice(2 * FIELD_START));
        if (text.length >= 4) found.add(text);
      }
      for (const word of vinsIn(asciiOfHex(message))) found.add(word);
    }
    for (const word of vinsIn(asciiOfHex(exchange.request))) found.add(word);
  }
  for (const text of captureTexts(capture)) for (const word of vinsIn(text)) found.add(word);
  return [...found];
}

/** `hex` with every byte-aligned occurrence of `needle` (upper-case hexadecimal bytes) overwritten with {@link REDACTED_BYTE}. */
function overwriteAligned(hex: string, needle: string): string {
  if (needle === "") return hex;
  let out = hex;
  let from = out.indexOf(needle);
  while (from >= 0) {
    if (from % 2 === 0) {
      out = `${out.slice(0, from)}${REDACTED_HEX.repeat(needle.length / 2)}${out.slice(from + needle.length)}`;
    }
    from = out.indexOf(needle, from + 1);
  }
  return out;
}

function overwriteSecrets(hex: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) => overwriteAligned(current, hexOfAscii(secret).toUpperCase()),
    hex,
  );
}

/** A reply message with its identifying data overwritten: the whole field of an identifying read, and each secret wherever it appears. */
function redactMessage(request: string, message: string, secrets: readonly string[]): string {
  const field = identifyingField(request, message)
    ? `${message.slice(0, 2 * FIELD_START)}${REDACTED_HEX.repeat(message.length / 2 - FIELD_START)}`
    : message;
  return overwriteSecrets(field, secrets);
}

function redactExchange(exchange: Exchange, secrets: readonly string[]): Exchange {
  const { outcome } = exchange;
  const spelled = secretSpellings(secrets);
  return {
    ...exchange,
    request: overwriteSecrets(exchange.request, secrets),
    outcome:
      outcome.kind === "replies"
        ? {
            ...outcome,
            replies: outcome.replies.map((reply) => ({
              ...reply,
              messages: reply.messages.map((message) =>
                redactMessage(exchange.request, message, secrets),
              ),
            })),
          }
        : { ...outcome, message: scrub(outcome.message, spelled) },
  };
}

/**
 * A copy of the shared capture with every identifying value overwritten ({@link captureIdentifyingValues}): in the raw bytes of requests and replies with {@link REDACTED_BYTE}, keeping each message's length, and in the notes, the description and error texts with `[redacted]`.
 */
export function redactCaptureShare(data: CaptureShareData): CaptureShareData {
  const { capture } = data;
  const secrets = captureIdentifyingValues(capture);
  const spelled = secretSpellings(secrets);
  return {
    redacted: true,
    capture: {
      ...capture,
      origin: { ...capture.origin, description: scrub(capture.origin.description, spelled) },
      notes: capture.notes.map((note) => scrub(note, spelled)),
      exchanges: capture.exchanges.map((exchange) => redactExchange(exchange, secrets)),
    },
  };
}
