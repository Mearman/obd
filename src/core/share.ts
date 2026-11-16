/**
 * Sharing results as a link: a scan, a generic OBD-II report, a run summary, a raw capture, a recording plan or the result of recording one, packed into the URL fragment.
 *
 * A link is `<app address>#share=2.<payload>`. Its content is a versioned envelope `{v, kind, createdAt, data}`. The payload is a head written as canonical JSON (keys sorted, ASCII only), for a capture followed by its exchanges packed into columns of bytes (`capture-pack.ts`): a capture's head holds its other fields by position with no field names, any other kind's holds the whole envelope. A raw capture so costs a fraction of its JSON size. The whole is compressed with raw deflate and written as unpadded base64url. A link of the first form, `#share=1.<payload>`, is the whole envelope's canonical JSON compressed the same way; it is still read. Both forms decode to exactly the envelope that was encoded. The data sits in the fragment, which a browser never sends to a server, so only whoever holds the link can read it.
 *
 * This module is platform-free. Compression goes through a {@link ShareCodec}, which each platform supplies (`pako` and `DecompressionStream` in the browser, `node:zlib` in Node), and both compress a payload to the same bytes. Decoding never throws: every failure, hostile input included, is a typed {@link ShareError}, and inflation stops as soon as the output passes {@link MAX_DECODED_BYTES}, so a small payload cannot expand without bound.
 *
 * Nothing in a link is written to storage or sent to an adapter by this module; a link carries fault history, so it is only as private as the place it is pasted.
 */

import { z } from "zod";
import type { Capture } from "./capture.js";
import {
  captureIdentifyingValues,
  captureShareSchema,
  redactCaptureShare,
  type CaptureShareData,
} from "./capture-share.js";
import { CAPTURE_FORMAT, CAPTURE_VERSION, MAX_NOTES, MAX_SESSIONS } from "./capture.js";
import { packExchanges, unpackExchanges, type PackTables } from "./capture-pack.js";
import { DIAG_PROTOCOLS } from "./guard.js";
import {
  MAX_ERROR_TEXT,
  addressKey,
  exchangeBusSchema,
  type Exchange,
  type ExchangeBus,
} from "./exchange.js";
import type { ObdScan } from "./obd-scan.js";
import { runExportSchema } from "./run-export.js";
import type { UnitReportData } from "./service.js";
import type { Json, Run, Sample, SignalAggregate } from "./storage.js";
import { asciiOfHex, isIdentifyingLabel, scrub, secretSpellings, vinsIn } from "./identifying.js";
import { canonicalJson } from "./canonical-json.js";
import { FAULT_LISTS } from "./fault-history.js";
import { MAX_REPEAT, PLAN_READS, planDigest, planSchema } from "./plan.js";
import { PHASE_OUTCOMES } from "./plan-runner.js";

export { canonicalJson } from "./canonical-json.js";

export { isIdentifyingLabel, redactVinShapes } from "./identifying.js";
export {
  REDACTED_BYTE,
  captureIdentifyingValues,
  captureShareSchema,
  redactCaptureShare,
  type CaptureShareData,
} from "./capture-share.js";

/** The envelope version this module writes and reads. */
export const SHARE_VERSION = 1;

/** The link form this module writes: `share=2.`, the envelope with a capture's exchanges packed into columns. */
export const LINK_VERSION = 2;

/** The link form of the whole envelope as canonical JSON, which this module still reads. */
export const JSON_LINK_VERSION = 1;

/** The link form of several results in one link, `#share=3.<payload>` ({@link encodeShareBundle}). */
export const BUNDLE_LINK_VERSION = 3;

/** The version of a bundle's own format, which its payload's head starts with. */
export const BUNDLE_VERSION = 1;

/** The most results one bundle link carries. */
export const MAX_BUNDLE_ITEMS = 50;

/** The most bytes the canonical JSON of an envelope may have, before and after compression; a packed link is held to the same limit on the envelope it decodes to. */
export const MAX_DECODED_BYTES = 256 * 1024;

/** The most characters a fragment (`share=2.<payload>`) may have; a longer link is refused unread. */
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

/** The deflate level every {@link ShareCodec} compresses at: zlib's highest, so a link is as short as zlib can make it. */
export const SHARE_DEFLATE_LEVEL = 9;

/** Raw-deflate compression, supplied by the platform. Both ends of a link must use the same format: RFC 1951 with no header or checksum. */
export interface ShareCodec {
  /** Compresses `bytes` at {@link SHARE_DEFLATE_LEVEL} with zlib's algorithm, so every platform writes the same bytes for the same payload. */
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
  | {
      readonly code: "invalid";
      readonly message: string;
      /** Every problem the schema found, each with its path; the message names the first. */
      readonly problems?: readonly string[];
    };

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

/** An `invalid` failure naming the schema's first problem and listing every one. */
function invalidIssues(error: z.ZodError): ShareResult<never> {
  return {
    ok: false,
    error: { code: "invalid", message: describeIssue(error), problems: issueLines(error) },
  };
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

const senderSchema = z.string().max(40);
const textListSchema = z.array(textSchema).max(2000);
const nullableTextListSchema = textListSchema.nullable();

const obdUnitSchema = z.strictObject({
  sender: senderSchema,
  lampOn: z.boolean().nullable(),
  codeCount: timeSchema.nullable(),
  stored: nullableTextListSchema,
  pending: nullableTextListSchema,
  permanent: nullableTextListSchema,
  readiness: z
    .strictObject({
      compressionIgnition: z.boolean(),
      complete: textListSchema,
      incomplete: textListSchema,
    })
    .nullable(),
  freezeFrame: z
    .strictObject({ code: textSchema.nullable(), values: z.record(keySchema, textSchema) })
    .nullable(),
  misfire: z
    .array(
      z.strictObject({
        monitor: textSchema,
        lastCycle: z.number().nullable(),
        averageLastTenCycles: z.number().nullable(),
      }),
    )
    .max(64),
  calibrationIds: z.array(textSchema).max(100),
});

/** The data of an `obd-report` link: what the legislated OBD-II reads said about a car (stored, pending and permanent codes, readiness monitors, the VIN, the freeze frame, current-data values with units and mode 06 results, as `ObdScan` holds them), with when it was read and the adapter's own name for itself. Code names are not carried; a reader looks them up from the codes. */
export const obdReportShareSchema = z.strictObject({
  /** When the read was taken, as a saved report records it. */
  taken: z.string().max(100),
  /** The adapter's own name for itself, such as `ELM327 v1.5`; never its address. */
  adapter: z.strictObject({ label: z.string().max(200) }),
  /** Whether the VIN and calibration identifiers were blanked before the link was written. */
  redacted: z.boolean(),
  obd: z.strictObject({
    /** The VIN, `null` when no unit reported one, or `""` when redaction blanked it. */
    vin: z.string().max(100).nullable(),
    units: z.array(obdUnitSchema).max(64),
    values: z
      .array(
        z.strictObject({
          sender: senderSchema,
          signal: nameSchema,
          unit: z.string().max(40),
          value: z.union([z.number(), textSchema]),
        }),
      )
      .max(2000),
    monitorResults: z
      .array(
        z.strictObject({
          sender: senderSchema,
          monitor: textSchema,
          test: z.string().max(40),
          scaling: z.string().max(40),
          value: z.number(),
          minimum: z.number(),
          maximum: z.number(),
          withinLimits: z.boolean(),
        }),
      )
      .max(4000),
    notes: z.array(textSchema).max(100),
  }),
});

/** What one generic OBD-II report shares. */
export type ObdReportShareData = z.output<typeof obdReportShareSchema>;

/** The data of a `plan` link: one recording plan, validated by the same schema as a plan file, so a plan from a link names only legislated values, waits only with a timeout and reads only through read-only services. */
export const planShareSchema = z.strictObject({ plan: planSchema });

/** What one plan link shares. */
export type PlanShareData = z.output<typeof planShareSchema>;

/** The most passes of phases a plan result carries: every phase of the longest plan repeated the most times it may. */
export const MAX_SHARED_PASSES = 1000;

/** The most fault code changes a plan result carries. */
export const MAX_CODE_EVENTS = 2000;

const unitCodesSchema = z.strictObject({
  unit: z.string().max(40),
  codes: z.array(z.string().max(20)).max(500),
});

/** One read a shared phase took, as the runner stored it, with its time as milliseconds since the run started. */
const sharedReadSchema = z.strictObject({
  read: z.enum(PLAN_READS),
  when: z.enum(["start", "end"]),
  at: timeSchema,
  result: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("codes"),
      list: z.enum(FAULT_LISTS),
      units: z.array(unitCodesSchema).max(64),
    }),
    z.strictObject({
      kind: z.literal("freeze-frame"),
      units: z
        .array(
          z.strictObject({
            unit: z.string().max(40),
            code: z.string().max(20).nullable(),
            values: z.record(keySchema, textSchema),
          }),
        )
        .max(64),
    }),
    z.strictObject({
      kind: z.literal("misfire-counters"),
      units: z
        .array(
          z.strictObject({
            unit: z.string().max(40),
            monitors: z
              .array(
                z.strictObject({
                  monitor: z.number().int(),
                  averageLastTenCycles: z.number().nullable(),
                  lastCycle: z.number().nullable(),
                }),
              )
              .max(64),
          }),
        )
        .max(64),
    }),
    z.strictObject({ kind: z.literal("failed"), error: textSchema }),
  ]),
});

/** One pass of one phase in a plan result: which phase, when it started and ended (milliseconds since the run started), how it ended and the reads it took. */
const sharedPhaseSchema = z.strictObject({
  phase: z.string().max(200),
  title: textSchema,
  iteration: z.number().int().min(1).max(MAX_REPEAT),
  start: timeSchema,
  end: timeSchema,
  outcome: z.enum(PHASE_OUTCOMES),
  reads: z.array(sharedReadSchema).max(2 * PLAN_READS.length),
});

/** The data of a `plan-result` link: which version of a plan was recorded, the run's summary, each phase's pass with its reads, and every fault code that appeared or cleared. Times are milliseconds since the run started, as the run summary's series are. */
export const planResultShareSchema = z
  .strictObject({
    /** The plan that was recorded, whole, so the link reads without it: validated as a plan file is. */
    plan: planSchema,
    /** The plan's {@link planDigest}, shown with its revision as the version label; it must match the plan. */
    planHash: z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 digest as lower-case hex"),
    /** Whether VIN-shaped words in the notes and the freeze frames were replaced before the link was written. */
    redacted: z.boolean(),
    run: runSummaryShareSchema,
    phases: z.array(sharedPhaseSchema).max(MAX_SHARED_PASSES),
    codeEvents: z
      .array(
        z.strictObject({
          at: timeSchema,
          list: z.enum(FAULT_LISTS),
          code: z.string().max(20),
          change: z.enum(["appeared", "cleared"]),
          /** The code was already there when the list was first read. */
          atStart: z.boolean(),
        }),
      )
      .max(MAX_CODE_EVENTS),
  })
  .superRefine((data, context) => {
    if (planDigest(data.plan) !== data.planHash) {
      context.addIssue({
        code: "custom",
        path: ["planHash"],
        message: "the digest does not match the plan the link carries",
      });
    }
  });

/** What one plan result shares. */
export type PlanResultShareData = z.output<typeof planResultShareSchema>;

/** The kinds of result a link carries. */
export const SHARE_KINDS = [
  "scan",
  "obd-report",
  "run-summary",
  "capture",
  "plan",
  "plan-result",
] as const;

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
    kind: z.literal("obd-report"),
    createdAt: timeSchema,
    data: obdReportShareSchema,
  }),
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("run-summary"),
    createdAt: timeSchema,
    data: runSummaryShareSchema,
  }),
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("capture"),
    createdAt: timeSchema,
    data: captureShareSchema,
  }),
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("plan"),
    createdAt: timeSchema,
    data: planShareSchema,
  }),
  z.strictObject({
    v: z.literal(SHARE_VERSION),
    kind: z.literal("plan-result"),
    createdAt: timeSchema,
    data: planResultShareSchema,
  }),
]);

/** A link's content. */
export type ShareEnvelope = z.output<typeof shareEnvelopeSchema>;

/** Several results in one link: the bundle's version, when it was made, whether every result had its identifying values removed, and the results in their order. */
export const shareBundleSchema = z.strictObject({
  v: z.literal(BUNDLE_VERSION),
  kind: z.literal("bundle"),
  createdAt: timeSchema,
  redacted: z.boolean(),
  items: z.array(shareEnvelopeSchema).min(1).max(MAX_BUNDLE_ITEMS),
});

/** Several results in one link. */
export type ShareBundle = z.output<typeof shareBundleSchema>;

/** What a link carries: one result, or a bundle of several. */
export type SharedLink = ShareEnvelope | ShareBundle;

/**
 * Every value in a scan that identifies the car or a unit: the values of identification entries {@link isIdentifyingLabel} names, and any VIN-shaped word in another identification value (as text or as the ASCII of its hexadecimal bytes) or in a note. A unit that gives its VIN inside an unlabelled identification block is caught by the second.
 */
function identifyingValues(data: ScanShareData): string[] {
  const found = new Set<string>();
  for (const unit of data.units) {
    for (const [label, value] of Object.entries(unit.identification)) {
      if (isIdentifyingLabel(label)) {
        for (const text of [value.text, value.hex]) if (text.length >= 4) found.add(text);
      }
      for (const word of [...vinsIn(value.text), ...vinsIn(asciiOfHex(value.hex))]) found.add(word);
    }
    for (const note of unit.notes) for (const word of vinsIn(note)) found.add(word);
  }
  return [...found];
}

/**
 * A copy of the scan with every identifying value removed ({@link isIdentifyingLabel} entries are blanked, and a VIN-shaped word is replaced wherever it appears: identification values, notes and freeze frames).
 */
export function redactScan(data: ScanShareData): ScanShareData {
  const secrets = secretSpellings(identifyingValues(data));
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

/** Every text in a generic OBD-II report that identifies the car or a unit: the VIN, the calibration identifiers, and any VIN-shaped word in a note, a freeze frame or a text reading. */
function obdIdentifyingValues(data: ObdReportShareData): string[] {
  const { obd } = data;
  const found = new Set<string>();
  if (obd.vin !== null && obd.vin.length >= 4) found.add(obd.vin);
  const searched: string[] = [...obd.notes];
  for (const unit of obd.units) {
    for (const text of unit.calibrationIds) if (text.length >= 4) found.add(text);
    searched.push(...Object.values(unit.freezeFrame?.values ?? {}));
  }
  for (const reading of obd.values) {
    if (typeof reading.value === "string") searched.push(reading.value);
  }
  for (const text of searched) for (const word of vinsIn(text)) found.add(word);
  return [...found];
}

/**
 * A copy of the generic OBD-II report with every identifying value removed: the VIN and each calibration identifier are blanked (`""`), and any copy of one, or any VIN-shaped word, in a note, a freeze frame or a text reading is replaced.
 */
export function redactObdReport(data: ObdReportShareData): ObdReportShareData {
  const secrets = secretSpellings(obdIdentifyingValues(data));
  const { obd } = data;
  return {
    ...data,
    redacted: true,
    obd: {
      ...obd,
      vin: obd.vin === null ? null : "",
      notes: obd.notes.map((note) => scrub(note, secrets)),
      units: obd.units.map((unit) => ({
        ...unit,
        calibrationIds: unit.calibrationIds.map(() => ""),
        freezeFrame:
          unit.freezeFrame === null
            ? null
            : {
                ...unit.freezeFrame,
                values: Object.fromEntries(
                  Object.entries(unit.freezeFrame.values).map(([name, value]) => [
                    name,
                    scrub(value, secrets),
                  ]),
                ),
              },
      })),
      values: obd.values.map((reading) => ({
        ...reading,
        value: typeof reading.value === "string" ? scrub(reading.value, secrets) : reading.value,
      })),
    },
  };
}

/** Every VIN-shaped word in a plan result: in the run's notes and in the freeze frames its phases read. */
function planResultIdentifyingValues(data: PlanResultShareData): string[] {
  const found = new Set<string>(vinsIn(data.run.run.notes));
  for (const pass of data.phases) {
    for (const read of pass.reads) {
      if (read.result.kind !== "freeze-frame") continue;
      for (const unit of read.result.units) {
        for (const value of Object.values(unit.values))
          for (const word of vinsIn(value)) found.add(word);
      }
    }
  }
  return [...found];
}

/** A copy of the plan result with every VIN-shaped word in its notes and freeze frames replaced. */
export function redactPlanResult(data: PlanResultShareData): PlanResultShareData {
  const secrets = secretSpellings(planResultIdentifyingValues(data));
  return {
    ...data,
    redacted: true,
    run: { ...data.run, run: { ...data.run.run, notes: scrub(data.run.run.notes, secrets) } },
    phases: data.phases.map((pass) => ({
      ...pass,
      reads: pass.reads.map((read) =>
        read.result.kind === "freeze-frame"
          ? {
              ...read,
              result: {
                ...read.result,
                units: read.result.units.map((unit) => ({
                  ...unit,
                  values: Object.fromEntries(
                    Object.entries(unit.values).map(([name, value]) => [
                      name,
                      scrub(value, secrets),
                    ]),
                  ),
                })),
              },
            }
          : read,
      ),
    })),
  };
}

/** The envelope with its identifying values removed: a scan, a generic OBD-II report, a capture and a plan result are redacted; a run summary and a plan have none and are returned as they are. */
export function redactEnvelope(envelope: ShareEnvelope): ShareEnvelope {
  switch (envelope.kind) {
    case "plan-result":
      return { ...envelope, data: redactPlanResult(envelope.data) };
    case "scan":
      return { ...envelope, data: redactScan(envelope.data) };
    case "obd-report":
      return { ...envelope, data: redactObdReport(envelope.data) };
    case "capture":
      return { ...envelope, data: redactCaptureShare(envelope.data) };
    case "plan":
    case "run-summary":
      return envelope;
  }
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
  /** The fragment without its `#`: `share=2.<payload>`. */
  readonly fragment: string;
  /** The envelope's canonical JSON size in bytes, which a decoder rebuilds and holds to {@link MAX_DECODED_BYTES}. */
  readonly decodedBytes: number;
  /** The payload's size in bytes before compression: the envelope with a capture's exchanges packed. */
  readonly packedBytes: number;
}

/** Options of {@link encodeShare}. */
export interface EncodeOptions {
  /** Blank the VIN and serial numbers of a scan, the VIN and calibration identifiers of a generic OBD-II report, or all three in a capture's raw bytes, first. */
  readonly redactVin?: boolean;
}

/** The longest head a packed payload may declare: no more than the envelope it is part of. */
const MAX_HEAD_BYTES = MAX_DECODED_BYTES;

const shortText = z.string().max(1000);
const nullableShort = shortText.nullable();

/** A bus in a packed head: `null`, `["can", idBits, bitrate]` or `["kline", scheme, tester, headerFormat]`. */
const packedBusSchema = z.union([
  z.null(),
  z.tuple([z.literal("can"), z.number(), z.number().nullable()]),
  z.tuple([z.literal("kline"), z.string().max(40), z.number(), z.number()]),
]);

/**
 * A packed capture's head, every field by position instead of by name: the kind, when the link was made (from the capture's start), whether it was redacted, the capture's id, start and length, its origin, each session (the adapter's fields but its address, which a shared capture never has, then the tool's), its notes, and the tables its packed exchanges refer to. The capture's `format` and `version` and the envelope's `v` are the only values their schemas allow, so they are not written.
 */
const packedCaptureHeadSchema = z.tuple([
  z.literal("capture"),
  z.number(),
  z.boolean(),
  shortText,
  z.number(),
  z.number(),
  z.tuple([z.string().max(40), z.string().max(200).nullable(), z.boolean(), shortText]),
  z
    .array(
      z.tuple([
        shortText,
        nullableShort,
        nullableShort,
        nullableShort,
        z.boolean().nullable(),
        shortText,
        shortText,
      ]),
    )
    .max(MAX_SESSIONS),
  z.array(shortText).max(MAX_NOTES),
  z.array(packedBusSchema).max(MAX_DECODED_BYTES),
  z.array(z.enum(DIAG_PROTOCOLS).nullable()).max(DIAG_PROTOCOLS.length + 1),
  z.array(z.string().max(MAX_ERROR_TEXT)).max(MAX_DECODED_BYTES),
]);

/** Any other kind's packed head: the kind and the whole envelope. */
const packedOtherHeadSchema = z.tuple([z.enum(SHARE_KINDS), z.unknown()]);

/** `value` as an unsigned variable-length integer, seven bits a byte, low bits first. */
function lengthBytes(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function packedBus(bus: ExchangeBus): Json {
  if (bus === null) return null;
  return bus.kind === "can"
    ? ["can", bus.idBits, bus.bitrate]
    : ["kline", bus.scheme, bus.tester, bus.headerFormat];
}

function unpackedBus(bus: z.output<typeof packedBusSchema>): unknown {
  if (bus === null) return null;
  return bus[0] === "can"
    ? { kind: "can", idBits: bus[1], bitrate: bus[2] }
    : { kind: "kline", scheme: bus[1], tester: bus[2], headerFormat: bus[3] };
}

/** The head of a packed capture ({@link packedCaptureHeadSchema}). */
function captureHead(
  envelope: Extract<ShareEnvelope, { kind: "capture" }>,
  tables: PackTables,
): Json {
  const { capture, redacted } = envelope.data;
  return [
    "capture",
    envelope.createdAt - capture.startedAt,
    redacted,
    capture.id,
    capture.startedAt,
    capture.endedAt - capture.startedAt,
    [
      capture.origin.kind,
      capture.origin.profile,
      capture.origin.complete,
      capture.origin.description,
    ],
    capture.sessions.map(({ adapter, tool }) => [
      adapter.identity,
      adapter.description,
      adapter.stnIdentity,
      adapter.voltage,
      adapter.hasStnExtensions,
      tool.name,
      tool.version,
    ]),
    capture.notes,
    tables.buses.map(packedBus),
    [...tables.protocols],
    [...tables.texts],
  ];
}

/**
 * The bytes a `share=2.` link compresses, for an envelope that already matches its schema (and is redacted when it is to be): the head's length, the head as canonical JSON and, for a capture, its exchanges packed. A capture's head is {@link packedCaptureHeadSchema}; any other kind's is the kind and the whole envelope.
 */
export function packedSharePayload(envelope: ShareEnvelope): Uint8Array {
  let head: Uint8Array;
  let body: Uint8Array = new Uint8Array(0);
  if (envelope.kind === "capture") {
    const { capture } = envelope.data;
    const packed = packExchanges(capture.exchanges, capture.startedAt);
    head = asciiBytes(canonicalJson(captureHead(envelope, packed.tables)));
    body = packed.bytes;
  } else {
    head = asciiBytes(canonicalJson([envelope.kind, envelope]));
  }
  const prefix = lengthBytes(head.length);
  const out = new Uint8Array(prefix.length + head.length + body.length);
  out.set(prefix, 0);
  out.set(head, prefix.length);
  out.set(body, prefix.length + head.length);
  return out;
}

/**
 * Writes an envelope as a link fragment.
 *
 * With `redactVin` a scan's, generic OBD-II report's or capture's identifying values are blanked first ({@link redactEnvelope}). Fails with `invalid` when the envelope does not match its kind's schema and with `too-large` when its canonical JSON passes {@link MAX_DECODED_BYTES} or the fragment passes {@link MAX_ENCODED_LENGTH}.
 */
export async function encodeShare(
  envelope: ShareEnvelope,
  codec: ShareCodec,
  options: EncodeOptions = {},
): Promise<ShareResult<EncodedShare>> {
  const forbidden = forbiddenKey(envelope);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = shareEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return invalidIssues(parsed.error);
  const checked = parsed.data;
  const chosen: ShareEnvelope = options.redactVin === true ? redactEnvelope(checked) : checked;
  const decodedBytes = canonicalJson(chosen).length;
  if (decodedBytes > MAX_DECODED_BYTES)
    return tooLarge("decoded", decodedBytes, true, MAX_DECODED_BYTES);
  const payload = packedSharePayload(chosen);
  const fragment = `${PREFIX}${String(LINK_VERSION)}.${toBase64Url(await codec.deflate(payload))}`;
  if (fragment.length > MAX_ENCODED_LENGTH) {
    return tooLarge("encoded", fragment.length, true, MAX_ENCODED_LENGTH);
  }
  return { ok: true, value: { fragment, decodedBytes, packedBytes: payload.length } };
}

/** Every problem in a schema error, each with its path, as `parsePlan` writes them. */
function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length === 0
      ? issue.message
      : `${issue.path.map(String).join(".")}: ${issue.message}`,
  );
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

/** Whether every byte is printable ASCII, as canonical JSON is. */
function printable(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
}

/** Parses canonical JSON text that must be an object. */
function jsonObject(bytes: Uint8Array): ShareResult<object> {
  if (!printable(bytes)) return failure("malformed", "the link payload is not canonical JSON");
  let value: unknown;
  try {
    value = JSON.parse(asciiText(bytes));
  } catch {
    return failure("malformed", "the link payload is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("invalid", "the link payload is not an envelope");
  }
  const forbidden = forbiddenKey(value);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  return { ok: true, value };
}

/** Checks a candidate envelope's version, kind and schema. */
function checkedEnvelope(value: unknown): ShareResult<ShareEnvelope> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("invalid", "the link payload is not an envelope");
  }
  const versionField: unknown = Reflect.get(value, "v");
  if (versionField !== SHARE_VERSION) {
    return failure("unsupported-version", "the envelope version is not supported");
  }
  const kind: unknown = Reflect.get(value, "kind");
  if (!isKind(kind)) {
    return failure("unsupported-kind", "the envelope kind is not supported");
  }
  const parsed = shareEnvelopeSchema.safeParse(value);
  if (!parsed.success) return invalidIssues(parsed.error);
  return { ok: true, value: parsed.data };
}

/** The head length a packed payload starts with, and where the head starts, or undefined when the length is not a shortest variable-length integer within {@link MAX_HEAD_BYTES}. */
function headLength(
  bytes: Uint8Array,
): { readonly length: number; readonly start: number } | undefined {
  let length = 0;
  let scale = 1;
  for (let index = 0; index < 4; index++) {
    const byte = bytes[index];
    if (byte === undefined) return undefined;
    length += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (byte === 0 && index > 0) return undefined;
      return length > MAX_HEAD_BYTES ? undefined : { length, start: index + 1 };
    }
    scale *= 0x80;
  }
  return undefined;
}

/** Parses canonical JSON text. */
function jsonValue(bytes: Uint8Array): ShareResult<unknown> {
  if (!printable(bytes)) return failure("malformed", "the link payload is not canonical JSON");
  let value: unknown;
  try {
    value = JSON.parse(asciiText(bytes));
  } catch {
    return failure("malformed", "the link payload is not JSON");
  }
  const forbidden = forbiddenKey(value);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  return { ok: true, value };
}

function withinLimit(envelope: ShareEnvelope, limit: number): ShareResult<ShareEnvelope> {
  const size = canonicalJson(envelope).length;
  return size > limit ? tooLarge("decoded", size, true, limit) : { ok: true, value: envelope };
}

/** The envelope a packed payload holds, rebuilt and checked against the envelope schema and `limit` bytes of canonical JSON, at most {@link MAX_DECODED_BYTES}. */
function unpackedEnvelope(bytes: Uint8Array, limit: number): ShareResult<ShareEnvelope> {
  const framing = headLength(bytes);
  if (framing === undefined || framing.start + framing.length > bytes.length) {
    return failure("malformed", "the link payload has no head");
  }
  const head = jsonValue(bytes.subarray(framing.start, framing.start + framing.length));
  if (!head.ok) return head;
  const rest = bytes.subarray(framing.start + framing.length);
  const kind: unknown = Array.isArray(head.value) ? head.value[0] : undefined;
  if (!isKind(kind)) return failure("unsupported-kind", "the envelope kind is not supported");
  if (kind !== "capture") {
    const other = packedOtherHeadSchema.safeParse(head.value);
    if (!other.success) return failure("invalid", describeIssue(other.error));
    if (rest.length > 0) return failure("malformed", "only a capture carries packed exchanges");
    const checked = checkedEnvelope(other.data[1]);
    if (!checked.ok) return checked;
    if (checked.value.kind !== other.data[0]) {
      return failure("malformed", "the head names another kind than its envelope");
    }
    return withinLimit(checked.value, limit);
  }
  const parsed = packedCaptureHeadSchema.safeParse(head.value);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  const [
    ,
    created,
    redacted,
    id,
    startedAt,
    length,
    origin,
    sessions,
    notes,
    buses,
    protocols,
    texts,
  ] = parsed.data;
  const busTable = z.array(exchangeBusSchema).safeParse(buses.map(unpackedBus));
  if (!busTable.success) return failure("invalid", describeIssue(busTable.error));
  const shell = checkedEnvelope({
    v: SHARE_VERSION,
    kind: "capture",
    createdAt: startedAt + created,
    data: {
      redacted,
      capture: {
        format: CAPTURE_FORMAT,
        version: CAPTURE_VERSION,
        id,
        startedAt,
        endedAt: startedAt + length,
        origin: {
          kind: origin[0],
          profile: origin[1],
          complete: origin[2],
          description: origin[3],
        },
        sessions: sessions.map(
          ([identity, description, stnIdentity, voltage, hasStnExtensions, name, version]) => ({
            adapter: { url: null, identity, description, stnIdentity, voltage, hasStnExtensions },
            tool: { name, version },
          }),
        ),
        exchanges: [],
        notes,
      },
    },
  });
  if (!shell.ok) return shell;
  if (shell.value.kind !== "capture") return failure("invalid", "not a capture");
  const envelope = shell.value;
  const { capture } = envelope.data;
  // Each exchange adds its canonical JSON and a comma to the empty list the head stands for; the first adds no comma.
  const budget = limit - canonicalJson(envelope).length + 1;
  const unpacked = unpackExchanges(
    rest,
    { buses: busTable.data, protocols, texts },
    capture.startedAt,
    budget,
    (exchange: Exchange) => canonicalJson(exchange).length,
  );
  if (unpacked === undefined) return failure("malformed", "the packed exchanges are not valid");
  if ("tooLarge" in unpacked) {
    return tooLarge("decoded", limit + 1, false, limit);
  }
  const rebuilt = checkedEnvelope({
    ...envelope,
    data: { ...envelope.data, capture: { ...capture, exchanges: unpacked.exchanges } },
  });
  return rebuilt.ok ? withinLimit(rebuilt.value, limit) : rebuilt;
}

/** A link's fragment with its version read and its payload inflated within {@link MAX_DECODED_BYTES}. */
async function inflatedLink(
  fragment: string,
  codec: ShareCodec,
): Promise<ShareResult<{ readonly version: number; readonly bytes: Uint8Array }>> {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (text.length > MAX_ENCODED_LENGTH) {
    return tooLarge("encoded", text.length, true, MAX_ENCODED_LENGTH);
  }
  if (!text.startsWith(PREFIX)) return failure("malformed", "not a share link");
  const token = text.slice(PREFIX.length);
  const dot = token.indexOf(".");
  if (dot < 0) return failure("malformed", "the link has no version");
  const version = [LINK_VERSION, JSON_LINK_VERSION, BUNDLE_LINK_VERSION].find(
    (known) => String(known) === token.slice(0, dot),
  );
  if (version === undefined) {
    return failure(
      "unsupported-version",
      `link version ${token.slice(0, dot).slice(0, 20)} is not supported`,
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
  return { ok: true, value: { version, bytes: inflated.bytes } };
}

/** The envelope of a one-result link's inflated payload: packed for `share=2.`, JSON for `share=1.`. */
function singleEnvelope(version: number, bytes: Uint8Array): ShareResult<ShareEnvelope> {
  if (version === LINK_VERSION) return unpackedEnvelope(bytes, MAX_DECODED_BYTES);
  const value = jsonObject(bytes);
  if (!value.ok) return value;
  return checkedEnvelope(value.value);
}

/**
 * Reads a link's fragment (with or without its `#`) back into an envelope: the packed form `share=2.` or the JSON form `share=1.`. A bundle link, `share=3.`, is refused with `unsupported-kind`; {@link decodeSharedLink} reads every form.
 *
 * Never throws. A fragment over {@link MAX_ENCODED_LENGTH} is refused before it is decoded, inflation stops past {@link MAX_DECODED_BYTES}, a packed capture stops being rebuilt once its canonical JSON would pass that limit, and the envelope must match its kind's strict schema: an unknown version, kind or field, or a key such as `__proto__`, is an error and nothing is partly read.
 */
export async function decodeShare(
  fragment: string,
  codec: ShareCodec,
): Promise<ShareResult<ShareEnvelope>> {
  try {
    const link = await inflatedLink(fragment, codec);
    if (!link.ok) return link;
    if (link.value.version === BUNDLE_LINK_VERSION) {
      return failure("unsupported-kind", "the link carries several results, not one");
    }
    return singleEnvelope(link.value.version, link.value.bytes);
  } catch {
    return failure("malformed", "the link could not be read");
  }
}

/** A bundle payload's head: the bundle version, when it was made, whether it was redacted, and the length of each result's packed payload. */
const bundleHeadSchema = z.tuple([
  z.literal(BUNDLE_VERSION),
  timeSchema,
  z.boolean(),
  z.array(z.number().int().nonnegative().max(MAX_DECODED_BYTES)).max(MAX_BUNDLE_ITEMS),
]);

/** The bundle a `share=3.` payload holds, each result rebuilt within what the ones before it left of {@link MAX_DECODED_BYTES}, and the whole checked against {@link shareBundleSchema}. */
function unpackedBundle(bytes: Uint8Array): ShareResult<ShareBundle> {
  const framing = headLength(bytes);
  if (framing === undefined || framing.start + framing.length > bytes.length) {
    return failure("malformed", "the link payload has no head");
  }
  const head = jsonValue(bytes.subarray(framing.start, framing.start + framing.length));
  if (!head.ok) return head;
  if (!Array.isArray(head.value) || head.value[0] !== BUNDLE_VERSION) {
    return failure("unsupported-version", "the bundle version is not supported");
  }
  const parsed = bundleHeadSchema.safeParse(head.value);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  const [, createdAt, redacted, lengths] = parsed.data;
  let offset = framing.start + framing.length;
  if (offset + lengths.reduce((sum, length) => sum + length, 0) !== bytes.length) {
    return failure("malformed", "the results' lengths do not match the payload");
  }
  const items: ShareEnvelope[] = [];
  // Each result after the first adds its canonical JSON and a comma to the bundle's.
  let used = 0;
  for (const length of lengths) {
    const item = unpackedEnvelope(
      bytes.subarray(offset, offset + length),
      MAX_DECODED_BYTES - used,
    );
    if (!item.ok) return item;
    items.push(item.value);
    used += canonicalJson(item.value).length + 1;
    offset += length;
  }
  const bundle = shareBundleSchema.safeParse({
    v: BUNDLE_VERSION,
    kind: "bundle",
    createdAt,
    redacted,
    items,
  });
  if (!bundle.success) return invalidIssues(bundle.error);
  const size = canonicalJson(bundle.data).length;
  return size > MAX_DECODED_BYTES
    ? tooLarge("decoded", size, true, MAX_DECODED_BYTES)
    : { ok: true, value: bundle.data };
}

/**
 * Reads any link's fragment (with or without its `#`): one result, as {@link decodeShare} reads it, or a bundle of several (`share=3.`).
 *
 * Never throws, and holds a bundle to the same limits as one result: the whole bundle's canonical JSON is within {@link MAX_DECODED_BYTES}, every result matches its kind's strict schema, and nothing is partly read.
 */
export async function decodeSharedLink(
  fragment: string,
  codec: ShareCodec,
): Promise<ShareResult<SharedLink>> {
  try {
    const link = await inflatedLink(fragment, codec);
    if (!link.ok) return link;
    return link.value.version === BUNDLE_LINK_VERSION
      ? unpackedBundle(link.value.bytes)
      : singleEnvelope(link.value.version, link.value.bytes);
  } catch {
    return failure("malformed", "the link could not be read");
  }
}

/** The results a bundle link is made from, and when. */
export interface BundleInput {
  readonly createdAt: number;
  readonly items: readonly ShareEnvelope[];
}

/**
 * Writes several results as one link fragment, `share=3.<payload>`: a head of the bundle's version, time, redaction and each result's length, then each result packed as a `share=2.` link packs it, the whole compressed and written as unpadded base64url.
 *
 * With `redactVin` every result has its identifying values removed ({@link redactEnvelope}), so one choice covers them all. Fails with `invalid` when the bundle does not match {@link shareBundleSchema} and with `too-large` when its canonical JSON passes {@link MAX_DECODED_BYTES} or the fragment passes {@link MAX_ENCODED_LENGTH}.
 */
export async function encodeShareBundle(
  input: BundleInput,
  codec: ShareCodec,
  options: EncodeOptions = {},
): Promise<ShareResult<EncodedShare>> {
  const candidate = {
    v: BUNDLE_VERSION,
    kind: "bundle",
    createdAt: input.createdAt,
    redacted: options.redactVin === true,
    items: input.items,
  };
  const forbidden = forbiddenKey(candidate);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = shareBundleSchema.safeParse(candidate);
  if (!parsed.success) return invalidIssues(parsed.error);
  const bundle: ShareBundle =
    options.redactVin === true
      ? { ...parsed.data, items: parsed.data.items.map(redactEnvelope) }
      : parsed.data;
  const decodedBytes = canonicalJson(bundle).length;
  if (decodedBytes > MAX_DECODED_BYTES) {
    return tooLarge("decoded", decodedBytes, true, MAX_DECODED_BYTES);
  }
  const payloads = bundle.items.map(packedSharePayload);
  const head = asciiBytes(
    canonicalJson([
      BUNDLE_VERSION,
      bundle.createdAt,
      bundle.redacted,
      payloads.map((payload) => payload.length),
    ]),
  );
  const prefix = lengthBytes(head.length);
  const payload = new Uint8Array(
    prefix.length + head.length + payloads.reduce((sum, item) => sum + item.length, 0),
  );
  payload.set(prefix, 0);
  payload.set(head, prefix.length);
  let offset = prefix.length + head.length;
  for (const item of payloads) {
    payload.set(item, offset);
    offset += item.length;
  }
  const fragment = `${PREFIX}${String(BUNDLE_LINK_VERSION)}.${toBase64Url(await codec.deflate(payload))}`;
  if (fragment.length > MAX_ENCODED_LENGTH) {
    return tooLarge("encoded", fragment.length, true, MAX_ENCODED_LENGTH);
  }
  return { ok: true, value: { fragment, decodedBytes, packedBytes: payload.length } };
}

/** One link of a split bundle: its fragment and the positions, in the bundle given, of the results it carries. */
export interface BundlePart {
  readonly fragment: string;
  readonly items: readonly number[];
}

/** Options of {@link splitShareBundle}. */
export interface SplitOptions extends EncodeOptions {
  /** The longest fragment a part may be, without the app's address and `#` before it. */
  readonly maxLength: number;
}

/**
 * Splits several results into as few links as keep each fragment within `maxLength`, in their order: each part takes the next results while its link still fits. A part of one result is an ordinary one-result link (`share=2.`), and a result whose own link is longer than `maxLength` is a part of its own, which the caller can tell by its length. One redaction choice covers every part.
 *
 * Fails as {@link encodeShare} and {@link encodeShareBundle} do, for the first part that cannot be written at all.
 */
export async function splitShareBundle(
  input: BundleInput,
  codec: ShareCodec,
  options: SplitOptions,
): Promise<ShareResult<readonly BundlePart[]>> {
  const encode = async (positions: readonly number[]): Promise<ShareResult<EncodedShare>> => {
    const items = positions.flatMap((position) => input.items.slice(position, position + 1));
    const [only] = items;
    return items.length === 1 && only !== undefined
      ? encodeShare({ ...only, createdAt: input.createdAt }, codec, options)
      : encodeShareBundle({ createdAt: input.createdAt, items }, codec, options);
  };
  const parts: BundlePart[] = [];
  let current: { readonly fragment: string; readonly items: readonly number[] } | undefined;
  for (let position = 0; position < input.items.length; position++) {
    if (current !== undefined) {
      const grown = [...current.items, position];
      const joined = await encode(grown);
      if (joined.ok && joined.value.fragment.length <= options.maxLength) {
        current = { fragment: joined.value.fragment, items: grown };
        continue;
      }
      parts.push(current);
    }
    const alone = await encode([position]);
    if (!alone.ok) return alone;
    current = { fragment: alone.value.fragment, items: [position] };
  }
  if (current !== undefined) parts.push(current);
  return { ok: true, value: parts };
}

function asciiText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** One line on a link's length against {@link PRACTICAL_LINK_LENGTH}: whether chat apps and mail clients keep it whole. */
export function describeLinkLength(length: number): string {
  return length > PRACTICAL_LINK_LENGTH
    ? `the link is ${String(length)} characters, over the ${String(PRACTICAL_LINK_LENGTH)} that chat apps and some mail clients keep whole: they may cut it, so send the file instead or check the link arrives in full`
    : `the link is ${String(length)} characters, within the ${String(PRACTICAL_LINK_LENGTH)} that chat apps and mail clients keep whole`;
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

/** The `format` a saved generic OBD-II read carries, as `obd --output` writes it. */
export const OBD_REPORT_FORMAT = "obd-report";

/** A generic OBD-II read saved as a file (`obd --output`): the structured result with when and through which adapter it was read, never the adapter's address. */
export interface ObdReportDocument {
  readonly tool: "obd-read";
  readonly format: typeof OBD_REPORT_FORMAT;
  readonly taken: string;
  readonly adapter: { readonly identity: string | null };
  readonly obd: ObdScan;
}

/** The document `obd --output` writes for a read. */
export function obdReportDocument(
  scan: ObdScan,
  read: { readonly takenAt: number; readonly adapterLabel: string },
): ObdReportDocument {
  return {
    tool: "obd-read",
    format: OBD_REPORT_FORMAT,
    taken: savedTime(read.takenAt),
    adapter: { identity: read.adapterLabel },
    obd: scan,
  };
}

const SAVED_OBD = z.object({
  tool: z.literal("obd-read"),
  format: z.literal(OBD_REPORT_FORMAT),
  taken: z.string(),
  adapter: z.object({ identity: z.string().nullable() }),
  obd: z.unknown(),
});

/** Checks a candidate against the schema and refuses a forbidden key. */
function checkedObdReport(candidate: unknown): ShareResult<ObdReportShareData> {
  const forbidden = forbiddenKey(candidate);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = obdReportShareSchema.safeParse(candidate);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  return { ok: true, value: parsed.data };
}

/**
 * What a generic OBD-II read shares: the structured result, when it was taken and the adapter's own name for itself. Fails with `invalid` when the result holds a key or a size the schema refuses.
 */
export function obdReportShareData(
  scan: ObdScan,
  read: { readonly takenAt: number; readonly adapterLabel: string },
): ShareResult<ObdReportShareData> {
  return checkedObdReport({
    taken: savedTime(read.takenAt),
    adapter: { label: read.adapterLabel },
    redacted: false,
    obd: scan,
  });
}

/** The shareable part of a saved generic OBD-II read ({@link obdReportDocument}). Fails with `invalid` when the document is not one. */
export function obdReportDocumentShareData(document: unknown): ShareResult<ObdReportShareData> {
  const forbidden = forbiddenKey(document);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const saved = SAVED_OBD.safeParse(document);
  if (!saved.success) {
    return failure("invalid", `not a saved OBD-II read: ${describeIssue(saved.error)}`);
  }
  return checkedObdReport({
    taken: saved.data.taken,
    adapter: { label: saved.data.adapter.identity ?? "" },
    redacted: false,
    obd: saved.data.obd,
  });
}

/**
 * What a capture shares: the capture document with every session's adapter address removed, so the receiver decodes the raw exchanges with any profile. Fails with `invalid` when the capture holds a key or a size the schema refuses.
 */
export function captureShareData(capture: Capture): ShareResult<CaptureShareData> {
  const candidate = {
    redacted: false,
    capture: {
      ...capture,
      sessions: capture.sessions.map((session) => ({
        ...session,
        adapter: { ...session.adapter, url: null },
      })),
    },
  };
  const forbidden = forbiddenKey(candidate);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = captureShareSchema.safeParse(candidate);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  return { ok: true, value: parsed.data };
}

/** The lines that introduce a shared capture: where it came from, what it holds and whether its identifying bytes were overwritten. */
export function describeSharedCapture(data: CaptureShareData): string[] {
  const { capture } = data;
  return [
    `shared capture ${capture.id} (started ${new Date(capture.startedAt).toISOString()}, ${plural(capture.exchanges.length, "exchange")} in ${plural(capture.sessions.length, "adapter session")}, ${capture.origin.description}${capture.origin.complete ? "" : ", incomplete"})`,
    data.redacted
      ? "the VIN, calibration identifiers and serial numbers were overwritten with * before sharing"
      : "the VIN, calibration identifiers and serial numbers are included",
  ];
}

/** A shared scan as a saved scan report, for the app to store when the user chooses to keep it. It reads in `compare` and `describe` like any report; `origin` marks it as shared and its transcript is empty. */
export function sharedScanReport(data: ScanShareData): Record<string, Json> {
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

/** A shared generic OBD-II read as the document `obd --output` writes, for the app to store when the user chooses to keep it; `origin` marks it as shared and `share` reads it back like any saved read. */
export function sharedObdReportDocument(data: ObdReportShareData): Record<string, Json> {
  return {
    tool: "obd-read",
    format: OBD_REPORT_FORMAT,
    origin: "shared",
    taken: data.taken,
    adapter: { identity: data.adapter.label },
    obd: data.obd,
  };
}

/** The readings a shared run summary carries, as samples of the run `runId`: each series point at the run's start plus its offset. A summary holds at most {@link MAX_SERIES_POINTS} readings of each signal, so these are a thinned copy of the sender's run. */
export function sharedRunSamples(data: RunSummaryShareData, runId: string): Sample[] {
  return data.signals
    .flatMap((signal) =>
      signal.series.map(([offset, value]) => ({
        runId,
        signal: signal.signal,
        unit: signal.unit,
        timestamp: data.run.startedAt + offset,
        value,
      })),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** When a saved copy of a shared run stops: when the sender's run stopped, or else at its last reading. */
export function sharedRunStop(data: RunSummaryShareData): number {
  return (
    data.run.stoppedAt ??
    data.signals.reduce(
      (latest, signal) =>
        Math.max(latest, ...signal.series.map(([offset]) => data.run.startedAt + offset)),
      data.run.startedAt,
    )
  );
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
  run: Pick<Run, "profile" | "adapter" | "startedAt" | "stoppedAt" | "notes">,
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

/** Per-signal summaries computed from samples, in the order each signal first appears. */
export function aggregateSamples(samples: readonly Sample[]): SignalAggregate[] {
  const bySignal = new Map<string, Sample[]>();
  for (const sample of samples) {
    const group = bySignal.get(sample.signal);
    if (group === undefined) bySignal.set(sample.signal, [sample]);
    else group.push(sample);
  }
  return Array.from(bySignal, ([signal, group]) => {
    const numbers = group.flatMap((sample) =>
      typeof sample.value === "number" ? [sample.value] : [],
    );
    const times = group.map((sample) => sample.timestamp);
    return {
      signal,
      unit: group[0]?.unit ?? "",
      count: group.length,
      numericCount: numbers.length,
      min: numbers.length === 0 ? null : numbers.reduce((a, b) => Math.min(a, b)),
      max: numbers.length === 0 ? null : numbers.reduce((a, b) => Math.max(a, b)),
      mean: numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length,
      firstAt: times.reduce((a, b) => Math.min(a, b)),
      lastAt: times.reduce((a, b) => Math.max(a, b)),
    };
  });
}

/** The run summary for a run's JSON export (`runs export` in the app, `exportRunJson` in core): aggregates are computed from the samples it holds. */
export function runExportShareData(document: unknown): ShareResult<RunSummaryShareData> {
  const forbidden = forbiddenKey(document);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = runExportSchema.safeParse(document);
  if (!parsed.success)
    return failure("invalid", `not a run export: ${describeIssue(parsed.error)}`);
  const { run, samples } = parsed.data;
  const checked = runSummaryShareSchema.safeParse(
    runSummaryShareData(run, aggregateSamples(samples), samples),
  );
  if (!checked.success) return failure("invalid", describeIssue(checked.error));
  return { ok: true, value: checked.data };
}

/** The lines of a shared run summary: where it came from, then each signal's range and series length. */
export function describeSharedRun(data: RunSummaryShareData, createdAt: number): string[] {
  const lines = [
    `shared run summary (profile ${data.run.profile}, adapter ${data.run.adapter}, started ${new Date(data.run.startedAt).toISOString()}, ${data.run.stoppedAt === null ? "still open" : `stopped ${new Date(data.run.stoppedAt).toISOString()}`}, link made ${new Date(createdAt).toISOString()})`,
  ];
  if (data.run.notes !== "") lines.push(`notes: ${data.run.notes}`);
  for (const signal of data.signals) {
    const range =
      signal.min === null || signal.max === null || signal.mean === null
        ? "no numeric readings"
        : `min ${String(signal.min)}, max ${String(signal.max)}, mean ${String(signal.mean)}`;
    lines.push(
      `${signal.signal}${signal.unit === "" ? "" : ` (${signal.unit})`}: ${String(signal.count)} readings, ${range}, ${String(signal.series.length)} series points`,
    );
  }
  return lines;
}

/** The ISO 8601 time to the second with a `+00:00` offset that a saved report records, from milliseconds since the Unix epoch. */
export function savedTime(milliseconds: number): string {
  return `${new Date(milliseconds).toISOString().slice(0, 19)}+00:00`;
}

/**
 * What a scan the service returned shares: its units, the profile it used and the adapter's own name for itself. Units without a name are not possible in the contract, so this never fails on a valid scan; an invalid one gives `invalid`.
 */
export function scanShareFromUnits(
  units: readonly UnitReportData[],
  scan: { readonly profile: string; readonly adapterLabel: string; readonly takenAt: number },
): ShareResult<ScanShareData> {
  const candidate = {
    taken: savedTime(scan.takenAt),
    profile: { name: scan.profile },
    adapter: { label: scan.adapterLabel },
    redacted: false,
    units: units.map((unit) => ({
      unit: unit.unit,
      description: unit.description,
      request_id: unit.requestId,
      response_id: unit.responseId,
      answered: unit.answered,
      notes: unit.notes,
      identification: Object.fromEntries(
        unit.identification.map((item) => [item.label, { hex: item.hex, text: item.text }]),
      ),
      faults: unit.faults,
      freeze_frames: unit.freezeFrames,
    })),
  };
  const forbidden = forbiddenKey(candidate);
  if (forbidden !== undefined) return failure("invalid", `the key ${forbidden} is not allowed`);
  const parsed = scanShareSchema.safeParse(candidate);
  if (!parsed.success) return failure("invalid", describeIssue(parsed.error));
  return { ok: true, value: parsed.data };
}

/** A shared scan's unit in the shape the screens show a scan the car gave. */
export function unitReportOf(unit: ScanShareData["units"][number]): UnitReportData {
  return {
    unit: unit.unit,
    description: unit.description,
    requestId: unit.request_id,
    responseId: unit.response_id,
    answered: unit.answered,
    notes: unit.notes,
    identification: Object.entries(unit.identification).map(([label, value]) => ({
      label,
      hex: value.hex,
      text: value.text,
    })),
    faults: unit.faults,
    freezeFrames: unit.freeze_frames,
  };
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : nouns}`;
}

/**
 * What a link made from this envelope carries, one plain sentence per kind of content, for a person to read before sharing. Redact first ({@link redactScan}) to describe a link that will have its VIN removed.
 */
export function shareContents(envelope: ShareEnvelope): string[] {
  if (envelope.kind === "plan") {
    const { plan } = envelope.data;
    return [
      `The plan ${plan.name}, ${plan.title}${plan.revision === undefined ? "" : ` at revision ${String(plan.revision)}`}: its description, safety text and source.`,
      `${plural(plan.phases.length, "phase")}, each with its instruction, what it samples, what it reads and when it ends.`,
      "No readings and nothing about your car: whoever opens the link records the plan on their own adapter.",
    ];
  }
  if (envelope.kind === "plan-result") {
    const { plan, planHash, run, phases, codeEvents, redacted } = envelope.data;
    const present = planResultIdentifyingValues(envelope.data).length;
    return [
      `The whole plan that was recorded, ${plan.name} at revision ${String(plan.revision ?? 1)}, digest ${planHash.slice(0, 12)}, so the link reads without it.`,
      `${plural(phases.length, "phase pass", "phase passes")} with start, end, outcome and the reads each took.`,
      `${plural(codeEvents.length, "fault code change")} with when each was seen.`,
      `${plural(run.signals.length, "signal")} with count, minimum, maximum and mean, and at most ${String(MAX_SERIES_POINTS)} readings of each over time; profile ${run.run.profile}, adapter ${run.run.adapter}.`,
      present > 0
        ? `VIN-shaped text in the notes or freeze frames: included (${plural(present, "value")}).`
        : redacted
          ? "VIN-shaped text in the notes and freeze frames: removed."
          : "No VIN was found in the notes or freeze frames.",
      "Not included: the other readings of the run and the adapter's address.",
    ];
  }
  if (envelope.kind === "run-summary") {
    const { run, signals } = envelope.data;
    return [
      `Run details: profile ${run.profile}, adapter ${run.adapter}, start and stop times${run.notes === "" ? "" : " and your notes"}.`,
      `${plural(signals.length, "signal")} with count, minimum, maximum and mean, and at most ${String(MAX_SERIES_POINTS)} readings of each over time.`,
      "Not included: the other readings of the run.",
    ];
  }
  if (envelope.kind === "capture") {
    const { capture, redacted } = envelope.data;
    const present = captureIdentifyingValues(capture).length;
    const addresses = new Set(capture.exchanges.map((exchange) => addressKey(exchange.address)));
    return [
      `${plural(capture.exchanges.length, "raw exchange")} (each request and every reply's bytes, with the bus and addressing) to ${plural(addresses.size, "address", "addresses")}, from ${plural(capture.sessions.length, "adapter session")}.`,
      "No decoded values: whoever opens the link chooses the profile it is decoded with.",
      present > 0
        ? `VIN, calibration identifiers and serial numbers: included (${plural(present, "value")}).`
        : redacted
          ? "VIN, calibration identifiers and serial numbers: overwritten with *."
          : "No VIN, calibration identifier or serial number was found in this capture.",
      "When it was captured, how it was made, its notes, and each adapter's own name for itself and the program that drove it.",
      "Not included: the adapter's address.",
    ];
  }
  if (envelope.kind === "obd-report") {
    const { obd, redacted } = envelope.data;
    const count = (kind: "stored" | "pending" | "permanent"): number =>
      obd.units.reduce((total, unit) => total + (unit[kind]?.length ?? 0), 0);
    const present = obdIdentifyingValues(envelope.data).length;
    return [
      `${plural(obd.units.length, "emissions control unit")}, with whether its warning lamp is on and which monitors have completed.`,
      `${plural(count("stored"), "stored code")}, ${plural(count("pending"), "pending code")} and ${plural(count("permanent"), "permanent code")}.`,
      `${plural(obd.units.filter((unit) => unit.freezeFrame !== null).length, "freeze frame")}, ${plural(obd.values.length, "current-data value")} with units and ${plural(obd.monitorResults.length, "mode 06 test result")}.`,
      present > 0
        ? `VIN and calibration identifiers: included (${plural(present, "value")}).`
        : redacted
          ? "VIN and calibration identifiers: removed."
          : "No VIN or calibration identifier was found in this read.",
      "The time of the read and the adapter's own name for itself.",
      "Not included: the raw adapter transcript and the adapter's address.",
    ];
  }
  const { units, redacted } = envelope.data;
  const faults = units.reduce((total, unit) => total + (unit.faults?.length ?? 0), 0);
  const frames = units.reduce((total, unit) => total + Object.keys(unit.freeze_frames).length, 0);
  const present = identifyingValues(envelope.data).length;
  return [
    `${plural(units.length, "control unit")}, with whether each answered and any notes it gave.`,
    `${plural(faults, "fault code")} with their status bytes.`,
    `${plural(frames, "freeze frame")}.`,
    present > 0
      ? `VIN and serial numbers: included (${plural(present, "value")}).`
      : redacted
        ? "VIN and serial numbers: removed."
        : "No VIN or serial number was found in this scan.",
    "Profile name, the time of the scan and the adapter's own name for itself.",
    "Not included: the raw adapter transcript and the adapter's address.",
  ];
}
