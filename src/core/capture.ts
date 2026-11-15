/**
 * A capture: every raw request and reply of one or more adapter sessions, kept independent of any vehicle profile so it can be decoded later under any profile, a newer version of one, or none.
 *
 * A capture stores no decoded value as its source of truth: each {@link Exchange} holds the bus and addressing in force, the request bytes and the raw outcome. `decodeCapture` (in `decode.ts`) turns it into the reports the commands print. The document is versioned and bounded: {@link parseCapture} refuses a file over {@link MAX_CAPTURE_TEXT} characters or {@link MAX_EXCHANGES} exchanges before building anything from it. This module is platform-free.
 */

import { z } from "zod";
import { toUpperHex } from "./bytes.js";
import type { AdapterInfo, Elm, LinkState } from "./elm.js";
import { exchangeSchema, timestampSchema, type Exchange } from "./exchange.js";

/** What every capture document's `format` field says. */
export const CAPTURE_FORMAT = "obd-read-capture";

/** The version of the capture document this module writes and reads. */
export const CAPTURE_VERSION = 1;

/** The longest capture document text {@link parseCapture} reads, in characters (32 MiB). */
export const MAX_CAPTURE_TEXT = 32 * 1024 * 1024;

/** The most exchanges one capture holds. */
export const MAX_EXCHANGES = 100_000;

/** The most adapter sessions one capture holds. */
export const MAX_SESSIONS = 64;

/** The most notes one capture holds. */
export const MAX_NOTES = 1000;

/** The tool's name, as captures record it. */
export const TOOL_NAME = "obd-read";

const shortText = z.string().max(1000);

/** The program that made a capture: its name and version. */
export const toolSchema = z.strictObject({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
});

/** The program that made a capture. */
export type Tool = z.output<typeof toolSchema>;

/**
 * What the adapter said about itself, and the URL it was opened with when that is known. `hasStnExtensions` is `null` when an imported transcript does not say.
 */
export const captureAdapterSchema = z.strictObject({
  url: shortText.nullable(),
  identity: shortText,
  description: shortText.nullable(),
  stnIdentity: shortText.nullable(),
  voltage: shortText.nullable(),
  hasStnExtensions: z.boolean().nullable(),
});

/** The adapter of one session. */
export type CaptureAdapter = z.output<typeof captureAdapterSchema>;

/** One adapter session a capture's exchanges came from: the adapter and the program that drove it. */
export const captureSessionSchema = z.strictObject({
  adapter: captureAdapterSchema,
  tool: toolSchema,
});

/** One adapter session of a capture. */
export type CaptureSession = z.output<typeof captureSessionSchema>;

/** How a capture was made. */
export const CAPTURE_KINDS = ["capture", "scan", "probe", "obd", "import"] as const;

/**
 * How a capture was made: by the capture operation, as the record of a scan, probe or `obd` read, or imported from a saved scan or an adapter transcript.
 *
 * `profile` is the profile the reads were chosen with, or `null`; it says what was asked, never how the capture must be decoded. `complete` is false when the capture was stopped before it finished. `description` is one line saying what was asked for.
 */
export const captureOriginSchema = z.strictObject({
  kind: z.enum(CAPTURE_KINDS),
  profile: z.string().min(1).max(200).nullable(),
  complete: z.boolean(),
  description: shortText,
});

/** How a capture was made. */
export type CaptureOrigin = z.output<typeof captureOriginSchema>;

/** A capture's identifier: letters, digits, dots, hyphens and underscores. */
export const captureIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "letters, digits, dots, hyphens and underscores");

/** The capture document. */
export const captureSchema = z
  .strictObject({
    format: z.literal(CAPTURE_FORMAT),
    version: z.literal(CAPTURE_VERSION),
    id: captureIdSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    origin: captureOriginSchema,
    sessions: z.array(captureSessionSchema).min(1).max(MAX_SESSIONS),
    exchanges: z.array(exchangeSchema).max(MAX_EXCHANGES),
    notes: z.array(shortText).max(MAX_NOTES),
  })
  .superRefine((capture, context) => {
    if (capture.endedAt < capture.startedAt) {
      context.addIssue({ code: "custom", path: ["endedAt"], message: "ends before it starts" });
    }
    let previous = -1;
    capture.exchanges.forEach((exchange, index) => {
      if (exchange.seq <= previous) {
        context.addIssue({
          code: "custom",
          path: ["exchanges", index, "seq"],
          message: "sequence numbers must increase",
        });
      }
      previous = exchange.seq;
      if (exchange.session >= capture.sessions.length) {
        context.addIssue({
          code: "custom",
          path: ["exchanges", index, "session"],
          message: `names session ${String(exchange.session)} of ${String(capture.sessions.length)}`,
        });
      }
    });
  });

/** A capture. */
export type Capture = z.output<typeof captureSchema>;

/** A capture document is not one this program reads. */
export class CaptureError extends Error {
  override name = "CaptureError";
}

/** The first few problems of a failed parse, each with where it is. */
function problemsOf(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length === 0 ? "document" : issue.path.map(String).join(".");
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${String(more)} more` : ""}`;
}

/**
 * Validates parsed JSON as a capture document.
 *
 * @throws CaptureError naming the problems, for anything that is not a version {@link CAPTURE_VERSION} capture within the bounds.
 */
export function validateCapture(data: unknown, where: string): Capture {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const format: unknown = Reflect.get(data, "format");
    const version: unknown = Reflect.get(data, "version");
    if (format === CAPTURE_FORMAT && version !== CAPTURE_VERSION) {
      throw new CaptureError(
        `${where}: capture version ${version === undefined ? "missing" : JSON.stringify(version)} is not one this program reads (it reads ${String(CAPTURE_VERSION)})`,
      );
    }
  }
  const parsed = captureSchema.safeParse(data);
  if (!parsed.success)
    throw new CaptureError(`${where}: not a capture: ${problemsOf(parsed.error)}`);
  return parsed.data;
}

/**
 * Parses a capture document's JSON text.
 *
 * @throws CaptureError when the text is longer than {@link MAX_CAPTURE_TEXT}, is not JSON, or is not a capture.
 */
export function parseCapture(text: string, where: string): Capture {
  if (text.length > MAX_CAPTURE_TEXT) {
    throw new CaptureError(
      `${where}: ${String(text.length)} characters is more than the ${String(MAX_CAPTURE_TEXT)} a capture may hold`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CaptureError(`${where}: ${error.message}`);
    throw error;
  }
  return validateCapture(data, where);
}

/**
 * A capture as JSON text: the metadata first, then one exchange per line, so a file reads and compares line by line. {@link parseCapture} reads it back to an equal capture.
 */
export function captureText(capture: Capture): string {
  const { exchanges, ...head } = capture;
  const top = JSON.stringify(head, null, 2);
  const body =
    exchanges.length === 0
      ? "[]"
      : `[\n${exchanges.map((exchange) => `    ${JSON.stringify(exchange)}`).join(",\n")}\n  ]`;
  return `${top.slice(0, -2)},\n  "exchanges": ${body}\n}\n`;
}

/** The session record of an adapter as a session reported it. */
export function captureAdapter(adapter: AdapterInfo, url: string | null): CaptureAdapter {
  return {
    url,
    identity: adapter.identity,
    description: adapter.description,
    stnIdentity: adapter.stnIdentity,
    voltage: adapter.voltage,
    hasStnExtensions: adapter.hasStnExtensions,
  };
}

/** What a {@link CaptureRecorder} needs. */
export interface RecorderOptions {
  /** The clock for exchange times; defaults to `Date.now`. */
  readonly now?: () => number;
  /** The most exchanges to keep; a recorder that reaches it stops and says so. Defaults to {@link MAX_EXCHANGES}. */
  readonly limit?: number;
}

/**
 * Records every request a session sends, from {@link CaptureRecorder.start} until {@link CaptureRecorder.stop}, as the exchanges of one capture session.
 */
export class CaptureRecorder {
  private readonly recorded: Exchange[] = [];
  private detach: (() => void) | undefined;
  private readonly now: () => number;
  private readonly limit: number;
  private overflowed = false;
  private stateAtStart: LinkState | undefined;

  constructor(
    private readonly elm: Elm,
    options: RecorderOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.limit = options.limit ?? MAX_EXCHANGES;
  }

  /** The bus and addressing the session was in when recording started. */
  get initialState(): LinkState {
    return this.stateAtStart ?? this.elm.state;
  }

  /** Whether exchanges were dropped because the limit was reached. */
  get full(): boolean {
    return this.overflowed;
  }

  /** The exchanges recorded so far, in order. */
  get exchanges(): readonly Exchange[] {
    return this.recorded;
  }

  /** Starts recording; does nothing when already recording. */
  start(): void {
    if (this.detach !== undefined) return;
    this.stateAtStart ??= this.elm.state;
    this.detach = this.elm.observe((observed) => {
      if (this.recorded.length >= this.limit) {
        this.overflowed = true;
        return;
      }
      this.recorded.push({
        seq: this.recorded.length,
        at: this.now(),
        session: 0,
        bus: observed.bus,
        address: observed.address,
        protocol: observed.protocol,
        request: toUpperHex(observed.request),
        outcome: observed.outcome,
      });
    });
  }

  /** Stops recording; what was recorded stays. */
  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }
}

/** What {@link buildCapture} puts around the exchanges. */
export interface CaptureFields {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly origin: CaptureOrigin;
  readonly session: CaptureSession;
  readonly notes?: readonly string[];
}

/**
 * A validated capture of one session's exchanges.
 *
 * @throws CaptureError when the fields or exchanges break the document's rules, which is a bug in the caller.
 */
export function buildCapture(fields: CaptureFields, exchanges: readonly Exchange[]): Capture {
  return validateCapture(
    {
      format: CAPTURE_FORMAT,
      version: CAPTURE_VERSION,
      id: fields.id,
      startedAt: fields.startedAt,
      endedAt: fields.endedAt,
      origin: fields.origin,
      sessions: [fields.session],
      exchanges,
      notes: [...(fields.notes ?? [])],
    },
    "capture",
  );
}

/**
 * A capture identifier from a time and a short random suffix the caller supplies, such as `capture-20261115T101500Z-3f9a`.
 */
export function captureId(at: number, suffix: string): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `capture-${stamp}-${suffix}`;
}
