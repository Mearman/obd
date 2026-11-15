/**
 * Turning older records into captures: an adapter transcript (the `--log` file, or the `transcript` of a saved scan) holds every command and reply line, so the raw exchanges can be recovered from it.
 *
 * {@link importTranscript} follows the adapter commands the session sent (protocol, header, receive filter, flow control, extended address, reset) to know the bus and addressing of each diagnostic request, and reads each request's reply lines with the same parser a live session uses (`parseReplyLines`). Whatever cannot be recovered is listed, never guessed: a K-line session (its replies are framed differently), a request line that is neither hexadecimal nor `STPX`, lines with no request, and lines whose time cannot be read. This module is platform-free.
 */

import { fromHex, hexNumber } from "./bytes.js";
import {
  CAPTURE_FORMAT,
  CAPTURE_VERSION,
  MAX_CAPTURE_TEXT,
  TOOL_NAME,
  validateCapture,
  type Capture,
  type CaptureAdapter,
  type CaptureSession,
} from "./capture.js";
import { CAN_PROTOCOLS, outcomeOf, parseReplyLines } from "./elm.js";
import type { Exchange, ExchangeAddress, ExchangeBus } from "./exchange.js";
import { FUNCTIONAL_ID } from "./obd.js";

/** A capture recovered from an older record, and what could not be recovered. */
export interface ImportedCapture {
  readonly capture: Capture;
  /** One line per thing that could not be turned into an exchange, saying where and why. */
  readonly unrecovered: readonly string[];
}

/** Where an imported capture came from and how to describe it. */
export interface ImportSource {
  readonly id: string;
  /** One line naming the record, such as `transcript run.log`. */
  readonly description: string;
  /** The profile the record was read with, if it says. */
  readonly profile: string | null;
  /** The adapter as the record describes it, used for a session whose transcript does not say. */
  readonly adapter?: Partial<CaptureAdapter>;
  /** Used when no line of the transcript carries a readable time. */
  readonly fallbackTime?: number;
}

/** The tool version imported sessions carry: the record does not say which version wrote it. */
export const UNKNOWN_VERSION = "unknown";

/** One transcript line. */
interface Entry {
  readonly line: number;
  readonly at: number | undefined;
  readonly sent: boolean;
  readonly text: string;
}

/** Parses a `<time> <direction> <text>` line; returns `undefined` for a line that is not one. */
function parseEntry(text: string, line: number): Entry | undefined {
  const match = /^(\S+) ([<>])(?: (.*))?$/.exec(text);
  if (match === null) return undefined;
  const [, stamp = "", direction, body = ""] = match;
  const at = Date.parse(stamp);
  return { line, at: Number.isNaN(at) ? undefined : at, sent: direction === ">", text: body };
}

/** The adapter state the transcript's commands set. */
interface State {
  idBits: 11 | 29 | undefined;
  bitrate: number | null;
  kline: boolean;
  header: number | undefined;
  priority: number;
  filter: number | undefined;
  flowControlOwn: boolean;
  extended: number | undefined;
  userOptions: number | undefined;
  userDivisor: number | undefined;
}

function freshState(): State {
  return {
    idBits: undefined,
    bitrate: null,
    kline: false,
    header: undefined,
    priority: 0x18,
    filter: undefined,
    flowControlOwn: false,
    extended: undefined,
    userOptions: undefined,
    userDivisor: undefined,
  };
}

/** A session being built: its adapter replies so far and its first line. */
interface SessionDraft {
  adapter: CaptureAdapter;
}

const HEX = /^(?:[0-9A-F]{2})+$/;

/** Applies one adapter command and its reply to the state and the session's adapter. */
function applyCommand(
  state: State,
  command: string,
  replies: readonly string[],
  session: SessionDraft,
): void {
  const reply = replies[0];
  if (command === "ATZ" || command === "ATWS" || command === "ATD") {
    Object.assign(state, freshState());
    if (command === "ATZ" && reply !== undefined) session.adapter.identity = reply;
    return;
  }
  if (command === "ATI" && reply !== undefined) session.adapter.identity = reply;
  else if (command === "AT@1" && reply !== undefined) session.adapter.description = reply;
  else if (command === "STI") {
    const known = reply !== undefined && reply !== "?";
    session.adapter.stnIdentity = known ? reply : null;
    session.adapter.hasStnExtensions = known;
  } else if (command === "ATRV" && reply !== undefined) session.adapter.voltage = reply;
  else if (command.startsWith("ATSP")) {
    const protocol = command.slice(4).replace(/^A/, "");
    const can = CAN_PROTOCOLS.find((entry) => entry.protocol === protocol);
    state.kline = ["3", "4", "5"].includes(protocol);
    if (can !== undefined) {
      state.idBits = can.idBits === 29 ? 29 : 11;
      state.bitrate = can.bitrate;
    } else if (
      protocol === "B" &&
      state.userOptions !== undefined &&
      state.userDivisor !== undefined
    ) {
      state.idBits = state.userOptions === 0x01 ? 29 : 11;
      state.bitrate = Math.floor(500_000 / state.userDivisor);
    } else if (!state.kline) {
      state.bitrate = null;
    }
  } else if (command.startsWith("ATPB ")) {
    const [options, divisor] = command.slice(5).split(" ");
    state.userOptions = options === undefined ? undefined : Number.parseInt(options, 16);
    state.userDivisor = divisor === undefined ? undefined : Number.parseInt(divisor, 16);
  } else if (command.startsWith("STPBR ")) {
    const rate = Number.parseInt(command.slice(6), 10);
    if (Number.isFinite(rate)) state.bitrate = rate;
  } else if (command.startsWith("ATCP")) {
    state.priority = Number.parseInt(command.slice(4), 16);
  } else if (command.startsWith("ATSH")) {
    const id = command.slice(4);
    if (/^[0-9A-F]{3}$/.test(id)) {
      state.header = Number.parseInt(id, 16);
      state.idBits ??= 11;
    } else if (/^[0-9A-F]{6}$/.test(id)) {
      state.header = state.priority * 2 ** 24 + Number.parseInt(id, 16);
      state.idBits ??= 29;
    }
  } else if (command.startsWith("ATCRA")) {
    const id = command.slice(5);
    state.filter = id === "" ? undefined : Number.parseInt(id, 16);
  } else if (command === "ATAR") {
    state.filter = undefined;
  } else if (command === "ATFCSM1") {
    state.flowControlOwn = true;
  } else if (command === "ATFCSM0") {
    state.flowControlOwn = false;
  } else if (command.startsWith("ATCEA")) {
    const address = command.slice(5);
    state.extended = address === "" ? undefined : Number.parseInt(address, 16);
  }
}

/** The address the state sends a request to. */
function addressOf(state: State): ExchangeAddress {
  const { header } = state;
  if (header === undefined) {
    return {
      mode: "functional",
      requestId: state.idBits === undefined ? null : FUNCTIONAL_ID[state.idBits],
    };
  }
  if (state.filter !== undefined) {
    return {
      mode: "physical",
      requestId: header,
      responseId: state.filter,
      extendedAddress: state.extended ?? null,
    };
  }
  if (header === FUNCTIONAL_ID[11] || header === FUNCTIONAL_ID[29]) {
    return { mode: "functional", requestId: header };
  }
  return { mode: "any-reply", requestId: header };
}

function busOf(state: State): ExchangeBus {
  return state.idBits === undefined
    ? null
    : { kind: "can", idBits: state.idBits, bitrate: state.bitrate };
}

/** The request bytes of a diagnostic request line, or `undefined` when the line is not one. */
function requestBytes(
  text: string,
): { readonly bytes: Uint8Array; readonly long: boolean } | undefined {
  const compact = text.replaceAll(" ", "").toUpperCase();
  if (HEX.test(compact)) return { bytes: fromHex(compact), long: false };
  const data = /^STPX.*D:([0-9A-F]+)/i.exec(text.replaceAll(" ", ""));
  if (data?.[1] !== undefined && HEX.test(data[1].toUpperCase())) {
    return { bytes: fromHex(data[1].toUpperCase()), long: true };
  }
  return undefined;
}

function emptyAdapter(defaults: Partial<CaptureAdapter> | undefined): CaptureAdapter {
  return {
    url: defaults?.url ?? null,
    identity: defaults?.identity ?? "unknown adapter",
    description: defaults?.description ?? null,
    stnIdentity: defaults?.stnIdentity ?? null,
    voltage: defaults?.voltage ?? null,
    hasStnExtensions: defaults?.hasStnExtensions ?? null,
  };
}

/**
 * Recovers the raw exchanges of an adapter transcript as a capture.
 *
 * Each `ATZ` starts a new adapter session, as a `--log` file appended to by several runs holds. A diagnostic request whose reply lines are an adapter error or unreadable is still an exchange, with that outcome, since that is what the session saw.
 *
 * @throws CaptureError when the transcript is longer than a capture may hold.
 */
export function importTranscript(lines: readonly string[], source: ImportSource): ImportedCapture {
  if (lines.reduce((total, line) => total + line.length + 1, 0) > MAX_CAPTURE_TEXT) {
    return validateCaptureOnly(source, ["the transcript is larger than a capture may hold"]);
  }
  const unrecovered: string[] = [];
  const entries: Entry[] = [];
  lines.forEach((text, index) => {
    if (text === "") return;
    const entry = parseEntry(text, index + 1);
    if (entry === undefined) unrecovered.push(`line ${String(index + 1)}: not a transcript line`);
    else entries.push(entry);
  });

  const sessions: CaptureSession[] = [];
  const exchanges: Exchange[] = [];
  const state = freshState();
  let draft: SessionDraft = { adapter: emptyAdapter(source.adapter) };
  let sessionIndex = -1;
  let klineReported = false;
  const ensureSession = (): number => {
    if (sessionIndex < 0) {
      sessions.push({
        adapter: draft.adapter,
        tool: { name: TOOL_NAME, version: UNKNOWN_VERSION },
      });
      sessionIndex = 0;
    }
    return sessionIndex;
  };

  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    index += 1;
    if (entry === undefined) break;
    if (!entry.sent) {
      unrecovered.push(`line ${String(entry.line)}: a received line with no request before it`);
      continue;
    }
    const replies: Entry[] = [];
    while (index < entries.length && entries[index]?.sent === false) {
      const reply = entries[index];
      if (reply !== undefined) replies.push(reply);
      index += 1;
    }
    const command = entry.text.trim().toUpperCase();
    const replyText = replies.map((reply) => reply.text);
    if (command.startsWith("AT") || (command.startsWith("ST") && !command.startsWith("STPX"))) {
      if (command === "ATZ") {
        draft = { adapter: emptyAdapter(source.adapter) };
        sessions.push({
          adapter: draft.adapter,
          tool: { name: TOOL_NAME, version: UNKNOWN_VERSION },
        });
        sessionIndex = sessions.length - 1;
      }
      applyCommand(state, command, replyText, draft);
      continue;
    }
    const request = requestBytes(entry.text);
    if (request === undefined) {
      unrecovered.push(
        `line ${String(entry.line)}: ${JSON.stringify(entry.text)} is not a diagnostic request`,
      );
      continue;
    }
    if (state.kline) {
      if (!klineReported) {
        unrecovered.push(
          `line ${String(entry.line)}: K-line requests are not recovered; their reply lines carry K-line framing this importer does not read`,
        );
        klineReported = true;
      }
      continue;
    }
    if (entry.at === undefined) {
      unrecovered.push(`line ${String(entry.line)}: the request's time cannot be read`);
      continue;
    }
    if (exchanges.length >= 100_000) {
      unrecovered.push(`line ${String(entry.line)}: the capture is full`);
      break;
    }
    let outcome: Exchange["outcome"] | undefined;
    if (replies.length === 0) {
      outcome = {
        kind: "transport-error",
        error: "TransportTimeout",
        message: "no reply line was recorded",
      };
    } else {
      try {
        outcome = outcomeOf({
          replies: parseReplyLines(replyText, {
            idBits: state.idBits ?? 11,
            extended: state.extended !== undefined,
            longRequest: request.long,
            request: request.bytes,
          }),
        });
      } catch (error) {
        outcome = outcomeOf({ error });
        if (outcome === undefined) throw error;
      }
    }
    if (outcome === undefined) continue;
    exchanges.push({
      seq: exchanges.length,
      at: entry.at,
      session: ensureSession(),
      bus: busOf(state),
      address: addressOf(state),
      protocol: null,
      request: Array.from(request.bytes, (value) => hexNumber(value, 2)).join(""),
      outcome,
    });
  }
  if (sessions.length === 0) {
    sessions.push({ adapter: draft.adapter, tool: { name: TOOL_NAME, version: UNKNOWN_VERSION } });
  }
  const times = entries.flatMap((entry) => (entry.at === undefined ? [] : [entry.at]));
  const startedAt = times.length === 0 ? (source.fallbackTime ?? 0) : Math.min(...times);
  const endedAt = times.length === 0 ? startedAt : Math.max(...times);
  return {
    capture: validateCapture(
      {
        format: CAPTURE_FORMAT,
        version: CAPTURE_VERSION,
        id: source.id,
        startedAt,
        endedAt,
        origin: {
          kind: "import",
          profile: source.profile,
          complete: unrecovered.length === 0,
          description: source.description,
        },
        sessions: sessions.slice(0, 64),
        exchanges,
        notes: unrecovered.slice(0, 1000),
      },
      source.description,
    ),
    unrecovered,
  };
}

/** An empty capture for a record nothing could be recovered from, with why. */
function validateCaptureOnly(source: ImportSource, unrecovered: string[]): ImportedCapture {
  const at = source.fallbackTime ?? 0;
  return {
    capture: validateCapture(
      {
        format: CAPTURE_FORMAT,
        version: CAPTURE_VERSION,
        id: source.id,
        startedAt: at,
        endedAt: at,
        origin: {
          kind: "import",
          profile: source.profile,
          complete: false,
          description: source.description,
        },
        sessions: [
          {
            adapter: emptyAdapter(source.adapter),
            tool: { name: TOOL_NAME, version: UNKNOWN_VERSION },
          },
        ],
        exchanges: [],
        notes: unrecovered,
      },
      source.description,
    ),
    unrecovered,
  };
}

/** A record an importer cannot read at all. */
export class ImportError extends Error {
  override name = "ImportError";
}

function stringField(data: object, key: string): string | undefined {
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Recovers the raw exchanges of a saved scan (`scan --output`) from its transcript.
 *
 * The scan's decoded units are not turned back into exchanges: without the transcript the requests and reply bytes are not known, so a scan with no transcript imports as an empty capture that says so.
 *
 * @throws ImportError when the text is not an obd-read saved scan.
 */
export function importSavedScan(text: string, id: string, name: string): ImportedCapture {
  if (text.length > MAX_CAPTURE_TEXT)
    throw new ImportError(`${name}: larger than a capture may hold`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportError(`${name}: ${error.message}`);
    throw error;
  }
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    stringField(data, "tool") !== TOOL_NAME
  ) {
    throw new ImportError(`${name}: not an obd-read saved scan`);
  }
  const profileField: unknown = Reflect.get(data, "profile");
  const profile =
    typeof profileField === "object" && profileField !== null
      ? (stringField(profileField, "name") ?? null)
      : null;
  const adapterField: unknown = Reflect.get(data, "adapter");
  const adapter: Partial<CaptureAdapter> =
    typeof adapterField === "object" && adapterField !== null
      ? {
          identity: stringField(adapterField, "identity") ?? "unknown adapter",
          description: stringField(adapterField, "description") ?? null,
          stnIdentity: stringField(adapterField, "stn_identity") ?? null,
          voltage: stringField(adapterField, "voltage") ?? null,
        }
      : {};
  const taken = stringField(data, "taken");
  const takenAt = taken === undefined ? Number.NaN : Date.parse(taken);
  const transcriptField: unknown = Reflect.get(data, "transcript");
  const transcript = Array.isArray(transcriptField)
    ? transcriptField.filter((line): line is string => typeof line === "string")
    : [];
  const source: ImportSource = {
    id,
    description: `saved scan ${name}`,
    profile,
    adapter,
    ...(Number.isNaN(takenAt) ? {} : { fallbackTime: takenAt }),
  };
  if (transcript.length === 0) {
    return validateCaptureOnly(source, [
      "the saved scan has no transcript, so its requests and raw replies cannot be recovered; its decoded units stay in the scan file",
    ]);
  }
  return importTranscript(transcript, source);
}
