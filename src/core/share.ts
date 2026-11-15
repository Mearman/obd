/**
 * Sharing results as a link: a scan or a run summary packed into the URL fragment.
 *
 * A link is `<app address>#share=1.<payload>`. The payload is a versioned envelope `{v, kind, createdAt, data}` written as canonical JSON (keys sorted, ASCII only), compressed with raw deflate and written as unpadded base64url. The data sits in the fragment, which a browser never sends to a server, so only whoever holds the link can read it.
 *
 * This module is platform-free. Compression goes through a {@link ShareCodec}, which each platform supplies (`CompressionStream` in the browser, `node:zlib` in Node). Decoding never throws: every failure, hostile input included, is a typed {@link ShareError}, and inflation stops as soon as the output passes {@link MAX_DECODED_BYTES}, so a small payload cannot expand without bound.
 *
 * Nothing in a link is written to storage or sent to an adapter by this module; a link carries fault history, so it is only as private as the place it is pasted.
 */

import { z } from "zod";
import type { Run, Sample, SignalAggregate } from "./storage.js";

/** The envelope version this module writes and reads. */
export const SHARE_VERSION = 1;

/** The most bytes the canonical JSON of an envelope may have, before and after compression. */
export const MAX_DECODED_BYTES = 256 * 1024;

/** The most characters a fragment (`share=1.<payload>`) may have; a longer link is refused unread. */
export const MAX_ENCODED_LENGTH = 32_000;

/** The link length that survives every browser, messenger and mail client; beyond it some of them truncate or break the link. */
export const PRACTICAL_LINK_LENGTH = 2000;

/** The most points of a signal's series a run summary carries. */
export const MAX_SERIES_POINTS = 120;

/** The most signals a run summary carries. */
export const MAX_SIGNALS = 64;

const PREFIX = "share=";

/** What inflating a payload gave: the bytes, or why it stopped. */
export type InflateResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large" | "corrupt" };

/** Raw-deflate compression, supplied by the platform. Both ends of a link must use the same format: RFC 1951 with no header or checksum. */
export interface ShareCodec {
  /** Compresses `bytes`. */
  deflate(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Decompresses `bytes`, giving up as soon as the output would pass `maxBytes`. Resolves with `{ok: false}` for a stream that is too large or not valid deflate; it never resolves with more than `maxBytes`.
   */
  inflate(bytes: Uint8Array, maxBytes: number): Promise<InflateResult>;
}

/** A link or payload that went over a size limit. */
export interface ShareTooLarge {
  readonly code: "too-large";
  /** Which size went over: the link's characters or the envelope's decoded bytes. */
  readonly stage: "encoded" | "decoded";
  /** The size found; when `exact` is false the size is only known to be at least this. */
  readonly size: number;
  readonly exact: boolean;
  readonly limit: number;
  readonly message: string;
}

/** Why a link could not be written or read. */
export type ShareError =
  | ShareTooLarge
  | { readonly code: "malformed"; readonly message: string }
  | { readonly code: "unsupported-version"; readonly message: string }
  | { readonly code: "unsupported-kind"; readonly message: string }
  | { readonly code: "invalid"; readonly message: string };

/** A value or the reason there is none. */
export type ShareResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ShareError };

function tooLarge(
  stage: "encoded" | "decoded",
  size: number,
  exact: boolean,
  limit: number,
): ShareResult<never> {
  const unit = stage === "encoded" ? "characters" : "bytes";
  const found = `${exact ? "" : "at least "}${String(size)}`;
  return {
    ok: false,
    error: {
      code: "too-large",
      stage,
      size,
      exact,
      limit,
      message: `the ${stage === "encoded" ? "link" : "data"} is ${found} ${unit} and the limit is ${String(limit)}; export the file instead (the report JSON, or the run as CSV or JSON)`,
    },
  };
}

function failure(
  code: "malformed" | "unsupported-version" | "unsupported-kind" | "invalid",
  message: string,
): ShareResult<never> {
  return { ok: false, error: { code, message } };
}

/** Object keys that would change an object's prototype or shadow what every object has. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The first own key anywhere in `value` that is in {@link FORBIDDEN_KEYS}, or undefined. Zod drops such a key from a record without an issue, so this runs on the parsed JSON first and the input is refused whole.
 */
function forbiddenKey(value: unknown): string | undefined {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== "object" || item === null) continue;
    for (const key of Object.getOwnPropertyNames(item)) {
      if (FORBIDDEN_KEYS.has(key)) return key;
      pending.push(Reflect.get(item, key));
    }
  }
  return undefined;
}

/** A record key; the names that reach an object's prototype are refused. */
const keySchema = z
  .string()
  .max(200)
  .refine((key) => !FORBIDDEN_KEYS.has(key), "a forbidden key");

const textSchema = z.string().max(4000);
const nameSchema = z.string().min(1).max(200);
const timeSchema = z.number().int().nonnegative();

const identificationSchema = z.strictObject({ hex: textSchema, text: textSchema });

const unitSchema = z.strictObject({
  unit: nameSchema,
  description: textSchema,
  request_id: z.string().max(40),
  response_id: z.string().max(40),
  answered: z.boolean(),
  notes: z.array(textSchema).max(100),
  identification: z.record(keySchema, identificationSchema),
  faults: z
    .array(z.strictObject({ code: nameSchema, status: z.string().max(40) }))
    .max(2000)
    .nullable(),
  freeze_frames: z.record(keySchema, textSchema),
});

/** The data of a `scan` link: what one scan read, in the saved scan report's field names without its raw transcript. */
export const scanShareSchema = z.strictObject({
  /** When the scan was taken, as the saved report records it. */
  taken: z.string().max(100),
  profile: z.strictObject({ name: nameSchema }),
  /** The adapter's own name for itself, such as `ELM327 v1.5`; never its address. */
  adapter: z.strictObject({ label: z.string().max(200) }),
  /** Whether the VIN and serial numbers were blanked before the link was written. */
  redacted: z.boolean(),
  units: z.array(unitSchema).max(64),
});

/** What one scan shares. */
export type ScanShareData = z.output<typeof scanShareSchema>;

const seriesPointSchema = z.tuple([timeSchema, z.number()]);

const signalSummarySchema = z.strictObject({
  signal: nameSchema,
  unit: z.string().max(40),
  count: timeSchema,
  numericCount: timeSchema,
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
  firstAt: timeSchema,
  lastAt: timeSchema,
  /** Numeric readings as `[milliseconds since the run started, value]`, thinned to at most {@link MAX_SERIES_POINTS}. */
  series: z.array(seriesPointSchema).max(MAX_SERIES_POINTS),
});

/** The data of a `run-summary` link: the run's details and each signal's summary and thinned series, never every sample. */
export const runSummaryShareSchema = z.strictObject({
  run: z.strictObject({
    profile: nameSchema,
    adapter: nameSchema,
    startedAt: timeSchema,
    stoppedAt: timeSchema.nullable(),
    notes: z.string().max(4000),
  }),
  signals: z.array(signalSummarySchema).max(MAX_SIGNALS),
});

/** What one run summary shares. */
export type RunSummaryShareData = z.output<typeof runSummaryShareSchema>;

/** The kinds of result a link carries. */
export const SHARE_KINDS = ["scan", "run-summary"] as const;

/** A link's content: the version, what kind of result it is, when it was made and the result. */
export const shareEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("scan"),
    createdAt: timeSchema,
    data: scanShareSchema,
  }),
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("run-summary"),
    createdAt: timeSchema,
    data: runSummaryShareSchema,
  }),
]);

/** A link's content. */
export type ShareEnvelope = z.output<typeof shareEnvelopeSchema>;

/** The labels of identification values that identify one car or one unit: the VIN and any serial number. */
const IDENTIFYING_LABEL = /\bvin\b|vehicle identification|serial/i;

/** Whether an identification value with this label identifies the car or the unit, so redaction blanks it. */
export function isIdentifyingLabel(label: string): boolean {
  return IDENTIFYING_LABEL.test(label);
}

const REDACTED = "[redacted]";

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.replaceAll(secret, REDACTED), text);
}

/**
 * A copy of the scan with every identification value {@link isIdentifyingLabel} names blanked, and each such value removed wherever else it appears (notes, other identification values, freeze frames).
 */
export function redactScan(data: ScanShareData): ScanShareData {
  const secrets = data.units
    .flatMap((unit) =>
      Object.entries(unit.identification)
        .filter(([label]) => isIdentifyingLabel(label))
        .flatMap(([, value]) => [value.hex, value.text]),
    )
    .filter((value) => value.length >= 4);
  return {
    ...data,
    redacted: true,
    units: data.units.map((unit) => ({
      ...unit,
      notes: unit.notes.map((note) => scrub(note, secrets)),
      identification: Object.fromEntries(
        Object.entries(unit.identification).map(([label, value]) => [
          label,
          isIdentifyingLabel(label)
            ? { hex: "", text: "" }
            : { hex: scrub(value.hex, secrets), text: scrub(value.text, secrets) },
        ]),
      ),
      freeze_frames: Object.fromEntries(
        Object.entries(unit.freeze_frames).map(([code, frame]) => [code, scrub(frame, secrets)]),
      ),
    })),
  };
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function sorted(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  throw new TypeError("a share envelope holds only JSON values");
}

/** JSON with every object's keys sorted and every character outside printable ASCII written as `\uXXXX`, so the same envelope is always the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const characters = Math.min(4, bytes.length - index + 1);
    for (let position = 0; position < characters; position++) {
      out += ALPHABET.charAt((chunk >> (18 - 6 * position)) & 63);
    }
  }
  return out;
}

/** The bytes of unpadded base64url text, or undefined when the text has another character, a length no byte string has, or non-zero spare bits. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of text) {
    accumulator = (accumulator << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (accumulator >> bits) & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  return accumulator === 0 ? out : undefined;
}

/** What {@link encodeShare} wrote. */
export interface EncodedShare {
  /** The fragment without its `#`: `share=1.<payload>`. */
  readonly fragment: string;
  /** The envelope's canonical JSON size in bytes, before compression. */
  readonly decodedBytes: number;
}

/** Options of {@link encodeShare}. */
export interface EncodeOptions {
  /** Blank the VIN and serial numbers of a scan first. */
  readonly redactVin?: boolean;
}

/**
 * Writes an envelope as a link fragment.
 *
 * With `redactVin` a scan's identifying values are blanked first ({@link redactScan}). Fails with `invalid` when the envelope does not match its kind's schema and with `too-large` when its canonical JSON passes {@link MAX_DECODED_BYTES} or the fragment passes {@link MAX_ENCODED_LENGTH}.
 */
export async function encodeShare(
  envelope: ShareEnvelope,
  codec: ShareCodec,
  options: EncodeOptions = {},
): Promise<ShareResult<EncodedShare>> {
  const forbidden = forbiddenKey(envelope);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = shareEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  const checked = parsed.data;
  const chosen: ShareEnvelope =
    options.redactVin === true && checked.kind === "scan"
      ? { ...checked, data: redactScan(checked.data) }
      : checked;
  const bytes = asciiBytes(canonicalJson(chosen));
  if (bytes.length > MAX_DECODED_BYTES)
    return tooLarge("decoded", bytes.length, true, MAX_DECODED_BYTES);
  const fragment = `${PREFIX}${String(SHARE_VERSION)}.${toBase64Url(await codec.deflate(bytes))}`;
  if (fragment.length > MAX_ENCODED_LENGTH) {
    return tooLarge("encoded", fragment.length, true, MAX_ENCODED_LENGTH);
  }
  return { ok: true, value: { fragment, decodedBytes: bytes.length } };
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "not a share envelope";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

function isKind(kind: unknown): boolean {
  return SHARE_KINDS.some((known) => known === kind);
}

/**
 * Reads a link's fragment (with or without its `#`) back into an envelope.
 *
 * Never throws. A fragment over {@link MAX_ENCODED_LENGTH} is refused before it is decoded, inflation stops past {@link MAX_DECODED_BYTES}, and the envelope must match its kind's strict schema: an unknown version, kind or field, or a key such as `__proto__`, is an error and nothing is partly read.
 */
export async function decodeShare(
  fragment: string,
  codec: ShareCodec,
): Promise<ShareResult<ShareEnvelope>> {
  try {
    const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
    if (text.length > MAX_ENCODED_LENGTH) {
      return tooLarge("encoded", text.length, true, MAX_ENCODED_LENGTH);
    }
    if (!text.startsWith(PREFIX)) return failure("malformed", "not a share link");
    const token = text.slice(PREFIX.length);
    const dot = token.indexOf(".");
    if (dot < 0) return failure("malformed", "the link has no version");
    const version = token.slice(0, dot);
    if (version !== String(SHARE_VERSION)) {
      return failure(
        "unsupported-version",
        `link version ${version.slice(0, 20)} is not supported`,
      );
    }
    const packed = fromBase64Url(token.slice(dot + 1));
    if (packed === undefined) return failure("malformed", "the link payload is not base64url");
    const inflated = await codec.inflate(packed, MAX_DECODED_BYTES);
    if (!inflated.ok) {
      return inflated.reason === "too-large"
        ? tooLarge("decoded", MAX_DECODED_BYTES + 1, false, MAX_DECODED_BYTES)
        : failure("malformed", "the link payload is not valid compressed data");
    }
    if (inflated.bytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
      return failure("malformed", "the link payload is not canonical JSON");
    }
    let value: unknown;
    try {
      value = JSON.parse(asciiText(inflated.bytes));
    } catch {
      return failure("malformed", "the link payload is not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return failure("invalid", "the link payload is not an envelope");
    }
    const forbidden = forbiddenKey(value);
    if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
    const versionField: unknown = Reflect.get(value, "v");
    if (versionField !== SHARE_VERSION) {
      return failure("unsupported-version", "the envelope version is not supported");
    }
    const kind: unknown = Reflect.get(value, "kind");
    if (!isKind(kind)) {
      return failure("unsupported-kind", "the envelope kind is not supported");
    }
    const parsed = shareEnvelopeSchema.safeParse(value);
    if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
    return { ok: true, value: parsed.data };
  } catch {
    return failure("malformed", "the link could not be read");
  }
}

function asciiText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** The fragment of a link in a page's address: `#share=...` as `location.hash` gives it, or undefined when the address carries no share. */
export function shareFragmentOf(hash: string): string | undefined {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  return text.startsWith(PREFIX) ? text : undefined;
}

/** The link for a fragment under an app address. A fragment already on `base` is replaced. */
export function shareLink(base: string, fragment: string): string {
  const hash = base.indexOf("#");
  return `${hash < 0 ? base : base.slice(0, hash)}#${fragment}`;
}

/** The share a link carries, taking a whole link or just its fragment; undefined when it has none. */
export function fragmentOfLink(link: string): string | undefined {
  const hash = link.indexOf("#");
  return shareFragmentOf(hash < 0 ? link : link.slice(hash));
}

const SAVED_UNIT = z.object({
  unit: nameSchema,
  description: z.string(),
  request_id: z.string(),
  response_id: z.string(),
  answered: z.boolean(),
  notes: z.array(z.string()),
  identification: z.record(z.string(), z.object({ hex: z.string(), text: z.string() })),
  faults: z.array(z.object({ code: z.string(), status: z.string() })).nullable(),
  freeze_frames: z.record(z.string(), z.string()),
});

const SAVED_SCAN = z.object({
  tool: z.literal("obd-read"),
  taken: z.string(),
  profile: z.object({ name: z.string() }),
  adapter: z.object({ identity: z.string().nullable() }),
  units: z.array(SAVED_UNIT),
});

/**
 * The shareable part of a saved scan report (the JSON `scan --output` writes and the app stores): everything but the raw transcript and the adapter's address.
 *
 * Fails with `invalid` when the report is not one, or when it holds a key {@link scanShareSchema} refuses.
 */
export function scanShareData(report: unknown): ShareResult<ScanShareData> {
  const forbidden = forbiddenKey(report);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const saved = SAVED_SCAN.safeParse(report);
  if (!saved.success) return failure("invalid", `not a saved scan: ${describeIssue(saved.error)}`);
  const candidate = {
    taken: saved.data.taken,
    profile: { name: saved.data.profile.name },
    adapter: { label: saved.data.adapter.identity ?? "" },
    redacted: false,
    units: saved.data.units.map((unit) => ({
      unit: unit.unit,
      description: unit.description,
      request_id: unit.request_id,
      response_id: unit.response_id,
      answered: unit.answered,
      notes: unit.notes,
      identification: unit.identification,
      faults: unit.faults,
      freeze_frames: unit.freeze_frames,
    })),
  };
  const parsed = scanShareSchema.safeParse(candidate);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  return { ok: true, value: parsed.data };
}

/** A saved scan report written from a shared scan: the fields `compare` and `describe` read, with an empty transcript and `origin` marking it as shared. */
export interface SharedScanReport {
  readonly tool: "obd-read";
  readonly origin: "shared";
  readonly taken: string;
  readonly profile: ScanShareData["profile"];
  readonly adapter: { readonly identity: string };
  readonly units: ScanShareData["units"];
  readonly transcript: readonly string[];
}

/** A shared scan as a saved scan report, for the app to store when the user chooses to keep it. */
export function sharedScanReport(data: ScanShareData): SharedScanReport {
  return {
    tool: "obd-read",
    origin: "shared",
    taken: data.taken,
    profile: data.profile,
    adapter: { identity: data.adapter.label },
    units: data.units,
    transcript: [],
  };
}

/** The lines of a shared scan: where it came from, then each unit's identification and fault codes. */
export function describeSharedScan(data: ScanShareData, createdAt: number): string[] {
  const lines = [
    `shared scan (taken ${data.taken}, profile ${data.profile.name}, adapter ${data.adapter.label === "" ? "unknown" : data.adapter.label}, link made ${new Date(createdAt).toISOString()})`,
    data.redacted
      ? "VIN and serial numbers were removed before sharing"
      : "VIN and serial numbers are included",
  ];
  for (const unit of data.units) {
    lines.push(`${unit.unit}: ${unit.answered ? "answered" : "no reply"}`);
    for (const [label, value] of Object.entries(unit.identification)) {
      lines.push(`  ${label}: ${value.text === "" ? "(removed)" : value.text}`);
    }
    if (unit.faults === null) lines.push("  fault codes not read");
    for (const fault of unit.faults ?? []) {
      lines.push(`  fault ${fault.code} status ${fault.status}`);
      const frame = unit.freeze_frames[fault.code];
      if (frame !== undefined) lines.push(`    freeze frame ${frame}`);
    }
  }
  return lines;
}

/** At most `limit` points of `points`, evenly spaced by position and always including the first and last. */
export function thin<T>(points: readonly T[], limit: number): T[] {
  if (points.length <= limit) return [...points];
  if (limit < 2) return points.slice(0, limit);
  const out: T[] = [];
  for (let index = 0; index < limit; index++) {
    const point = points[Math.round((index * (points.length - 1)) / (limit - 1))];
    if (point !== undefined) out.push(point);
  }
  return out;
}

function roundTo(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundTo(value);
}

/**
 * The shareable summary of a run: its details, and per signal the aggregate and a series of its numeric readings thinned to {@link MAX_SERIES_POINTS}, so a run of any length stays within the size limits. Signals beyond {@link MAX_SIGNALS} are left out, the most-sampled first kept.
 *
 * `samples` need not be sorted; readings that are not numbers are left out of the series.
 */
export function runSummaryShareData(
  run: Run,
  aggregates: readonly SignalAggregate[],
  samples: readonly Sample[],
): RunSummaryShareData {
  const kept = [...aggregates].sort((a, b) => b.count - a.count).slice(0, MAX_SIGNALS);
  return {
    run: {
      profile: run.profile,
      adapter: run.adapter,
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
      notes: run.notes,
    },
    signals: kept.map((aggregate) => {
      const numeric = samples
        .filter((sample) => sample.signal === aggregate.signal && typeof sample.value === "number")
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((sample): [number, number] => [
          Math.max(0, sample.timestamp - run.startedAt),
          typeof sample.value === "number" ? roundTo(sample.value) : 0,
        ]);
      return {
        signal: aggregate.signal,
        unit: aggregate.unit,
        count: aggregate.count,
        numericCount: aggregate.numericCount,
        min: roundOrNull(aggregate.min),
        max: roundOrNull(aggregate.max),
        mean: roundOrNull(aggregate.mean),
        firstAt: aggregate.firstAt,
        lastAt: aggregate.lastAt,
        series: thin(numeric, MAX_SERIES_POINTS),
      };
    }),
  };
}
