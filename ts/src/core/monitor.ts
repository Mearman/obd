/**
 * Passive logging of CAN traffic: nothing here transmits.
 *
 * Through a raw CAN link the log is complete: the link is opened listen-only and only its receive
 * side is handed to the monitor, so there is no way to send from it. Through an ELM327-style
 * adapter the log holds what the adapter's filters let through, and every command the monitor
 * sends passes an allowlist first (`monitorCommand`). With the STN extensions the adapter is put in
 * the monitoring mode that does not acknowledge frames (`STCMM 0`); whether a plain ELM327
 * acknowledges frames while monitoring is unconfirmed.
 */

import { asciiDecode, asciiEncode, fromHex, hexNumber, toUpperHex } from "./bytes.js";
import type { CanFrame } from "./can.js";
import { Elm, ElmError, PROMPT, Transcript, type AdapterInfo } from "./elm.js";
import { GuardError } from "./guard.js";
import { OptionError } from "./options.js";
import { RawCanTransport } from "./rawcan.js";
import { now } from "./time.js";
import { TransportTimeout, type Transport } from "./transport.js";
import type { LineSink } from "./unit-access.js";
import { pythonRepr } from "./format.js";

/** Builds the unopened transport an adapter URL names. */
export type TransportOpener = (url: string) => Transport;

// Identifier masks for the STN pass and block filters.
const MASK_11 = 0x7ff;
const MASK_29 = 0x1fff_ffff;

/** How long each read waits while streaming, in milliseconds. */
export const POLL_MS = 500;

/** How long to wait for the adapter to stop monitoring, in milliseconds. */
export const STOP_WAIT_MS = 3000;

const HEX_ID = "(?:[0-9A-F]{3}|[0-9A-F]{8})";
const STN_FILTER = "[0-9A-F]{1,10},[0-9A-F]{1,10}";

// The only commands the monitor sends to an adapter, with spaces removed and upper-cased: receive
// filters, the monitoring commands and the monitoring mode that does not acknowledge.
const ALLOWED_COMMANDS: readonly RegExp[] = [
  `ATCRA${HEX_ID}?`,
  "AT(?:CF|CM)(?:[0-9A-F]{3}|[0-9A-F]{8})",
  "ATMA",
  "STM",
  "STFAC",
  `ST(?:FPA|FBA|FFCA)${STN_FILTER}`,
  "STCMM0",
].map((pattern) => new RegExp(`^${pattern}$`));

/**
 * Passes one adapter command the monitor may send, or refuses it.
 *
 * @throws GuardError for anything that is not a receive filter, a monitoring command or the
 * non-acknowledging monitoring mode.
 */
export function monitorCommand(text: string): string {
  const compact = text.replaceAll(" ", "").toUpperCase();
  if (!ALLOWED_COMMANDS.some((pattern) => pattern.test(compact))) {
    throw new GuardError(`monitor command ${pythonRepr(text)} refused: the monitor only listens`);
  }
  return text;
}

/**
 * Which identifiers the log keeps. With no `passIds` every identifier passes, except `blockIds`.
 */
export class MonitorFilter {
  constructor(
    readonly passIds: readonly number[] = [],
    readonly blockIds: readonly number[] = [],
    readonly flowControlIds: readonly number[] = [],
  ) {}

  /** Whether a frame with this identifier is kept. */
  accepts(canId: number): boolean {
    if (this.blockIds.includes(canId)) return false;
    return (
      this.passIds.length === 0 ||
      this.passIds.includes(canId) ||
      this.flowControlIds.includes(canId)
    );
  }
}

function idWidth(idBits: number): number {
  return idBits === 11 ? 3 : 8;
}

/** One log line: UTC time, identifier, data in hexadecimal. */
export function formatFrame(moment: Date, canId: number, data: Uint8Array, idBits: number): string {
  const stamp = moment.toISOString().replace("Z", "+00:00");
  return `${stamp} ${hexNumber(canId, idWidth(idBits))} ${toUpperHex(data)}`.trimEnd();
}

/**
 * Reads one monitor line from an adapter that prints headers without spaces.
 *
 * Returns `undefined` for a line that is not a frame, such as a status message.
 */
export function parseStreamLine(
  line: string,
  idBits: number,
): [canId: number, data: Uint8Array] | undefined {
  const compact = line.replaceAll(" ", "").toUpperCase();
  const match = new RegExp(`^([0-9A-F]{${String(idWidth(idBits))}})((?:[0-9A-F]{2}){0,8})$`).exec(
    compact,
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return [Number.parseInt(match[1], 16), fromHex(match[2])];
}

/** The receive side of a CAN link, and nothing else. */
export interface FrameSource {
  /** Returns the next frame, rejecting with TransportTimeout when none arrives in `timeoutMs`. */
  receive(timeoutMs: number): Promise<CanFrame>;
}

/** Where frames go, and when the monitor should stop. */
export class MonitorLog {
  /** Frames logged so far. */
  frames = 0;
  /** Status lines the adapter printed that were not frames. */
  readonly notes: string[] = [];

  /**
   * @param emit Takes each log line.
   * @param idBits The identifier width the frames are printed with.
   * @param countLimit Stop after this many frames; absent means no limit.
   */
  constructor(
    private readonly emit: (line: string) => void | Promise<void>,
    readonly idBits: number,
    private readonly countLimit?: number,
  ) {}

  /** Logs one frame. */
  async frame(canId: number, data: Uint8Array): Promise<void> {
    await this.emit(formatFrame(new Date(), canId, data, this.idBits));
    this.frames += 1;
  }

  /** Logs one status line, marked as a comment. */
  async note(text: string): Promise<void> {
    this.notes.push(text);
    await this.emit(`# ${text}`);
  }

  /** Whether the frame count has reached its limit. */
  get done(): boolean {
    return this.countLimit !== undefined && this.frames >= this.countLimit;
  }
}

/** The time left before `deadline`, capped at one poll; `Infinity` deadlines poll at full length. */
function pollFor(deadline: number | undefined): number {
  return deadline === undefined ? POLL_MS : Math.min(POLL_MS, deadline - now());
}

/**
 * Logs every frame the link receives that the filter keeps, until the count or duration is
 * reached.
 */
export async function monitorRaw(
  source: FrameSource,
  log: MonitorLog,
  frameFilter: MonitorFilter,
  durationMs?: number,
): Promise<void> {
  const deadline = durationMs === undefined ? undefined : now() + durationMs;
  while (!log.done) {
    const remaining = pollFor(deadline);
    if (remaining <= 0) return;
    let frame: CanFrame;
    try {
      frame = await source.receive(remaining);
    } catch (error) {
      if (error instanceof TransportTimeout) continue;
      throw error;
    }
    if (frameFilter.accepts(frame.canId)) await log.frame(frame.canId, frame.data);
  }
}

/** An identifier as the STN filter commands write it: two bytes for 11-bit, four for 29-bit. */
export function idPattern(canId: number, idBits: number): string {
  return hexNumber(canId, idBits === 11 ? 4 : 8);
}

async function setup(elm: Elm, command: string): Promise<void> {
  await elm.require(monitorCommand(command));
}

/**
 * Sets the adapter's own receive filters as far as its command set allows.
 *
 * The software filter in the log applies in every case, so a filter the adapter cannot express
 * (several identifiers on a plain adapter, a block list) is still honoured, at the cost of more
 * traffic over the link.
 */
export async function configureFilters(
  elm: Elm,
  info: AdapterInfo,
  frameFilter: MonitorFilter,
  idBits: number,
): Promise<void> {
  if (info.hasStnExtensions) {
    const mask = idPattern(idBits === 11 ? MASK_11 : MASK_29, idBits);
    await setup(elm, "STFAC");
    const groups: readonly (readonly [string, readonly number[]])[] = [
      ["STFPA", frameFilter.passIds],
      ["STFBA", frameFilter.blockIds],
      ["STFFCA", frameFilter.flowControlIds],
    ];
    for (const [command, ids] of groups) {
      for (const canId of ids) await setup(elm, `${command} ${idPattern(canId, idBits)},${mask}`);
    }
    await setup(elm, "STCMM0");
    return;
  }
  const wanted = [...frameFilter.passIds, ...frameFilter.flowControlIds];
  const width = idWidth(idBits);
  const [first] = wanted;
  if (first === undefined) return;
  if (wanted.length === 1) {
    await setup(elm, `ATCRA${hexNumber(first, width)}`);
    return;
  }
  // One filter and mask: the bits every wanted identifier agrees on must match.
  let agreed = ~0;
  for (const canId of wanted.slice(1)) agreed &= ~(canId ^ first);
  const full = idBits === 11 ? MASK_11 : MASK_29;
  await setup(elm, `ATCF${hexNumber(first, width)}`);
  await setup(elm, `ATCM${hexNumber(agreed & full, width)}`);
}

function takeLine(
  line: string,
  log: MonitorLog,
  frameFilter: MonitorFilter,
  transcript: Transcript,
): Promise<void> {
  if (line === "") return Promise.resolve();
  const parsed = parseStreamLine(line, log.idBits);
  if (parsed === undefined) {
    transcript.record("<", line);
    return log.note(`adapter: ${line}`);
  }
  return frameFilter.accepts(parsed[0]) ? log.frame(...parsed) : Promise.resolve();
}

/** Any byte stops the adapter's monitoring; waits for its prompt so the link is left in a known state. */
async function stop(transport: Transport): Promise<void> {
  await transport.write(asciiEncode("\r"));
  const deadline = now() + STOP_WAIT_MS;
  let seen = "";
  while (!seen.includes(String.fromCharCode(PROMPT))) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new ElmError("the adapter did not stop monitoring");
    try {
      seen += asciiDecode(await transport.read(remaining));
    } catch (error) {
      if (error instanceof TransportTimeout) {
        throw new ElmError("the adapter did not stop monitoring", { cause: error });
      }
      throw error;
    }
  }
}

/** Logs frames through an ELM327-style adapter's monitoring mode, then stops it. */
export async function monitorElm(
  elm: Elm,
  info: AdapterInfo,
  log: MonitorLog,
  frameFilter: MonitorFilter,
  durationMs?: number,
): Promise<void> {
  await configureFilters(elm, info, frameFilter, log.idBits);
  const transport = elm.transport;
  const start = monitorCommand(info.hasStnExtensions ? "STM" : "ATMA");
  elm.transcript.record(">", start);
  await transport.write(asciiEncode(`${start}\r`));
  const deadline = durationMs === undefined ? undefined : now() + durationMs;
  let buffer = "";
  try {
    while (!log.done) {
      const remaining = pollFor(deadline);
      if (remaining <= 0) break;
      try {
        buffer += asciiDecode(await transport.read(remaining));
      } catch (error) {
        if (error instanceof TransportTimeout) continue;
        throw error;
      }
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        await takeLine(line.trim().replace(/^>+/, "").trim(), log, frameFilter, elm.transcript);
      }
    }
  } finally {
    await stop(transport);
  }
}

/** A destination for log lines that a platform opens, such as a new file. */
export interface LogSink {
  write(line: string): Promise<void>;
  close(): Promise<void>;
}

/** What the monitor command was asked for. */
export interface MonitorOptions {
  /** The adapter URL, handed to the transport opener. */
  readonly adapter: string;
  readonly idBits: 11 | 29;
  readonly bitrate: number;
  /** Keep only these identifiers. */
  readonly ids?: readonly number[];
  /** Drop these identifiers. */
  readonly block?: readonly number[];
  /** Also keep these flow-control identifiers. */
  readonly flowControl?: readonly number[];
  /** Stop after this many milliseconds. */
  readonly durationMs?: number;
  /** Stop after this many frames. */
  readonly count?: number;
  /**
   * Writes the log to a destination the platform opens (a new file, which it refuses to replace)
   * instead of `out`. `label` names it in the closing line.
   */
  readonly output?: { readonly label: string; open(): Promise<LogSink> };
  /** Receives each adapter transcript entry, for a platform that appends it to a file. */
  readonly transcriptSink?: (entry: string) => void;
}

/**
 * Runs the `monitor` command and returns its exit status.
 *
 * @throws OptionError when an identifier does not fit the identifier width.
 */
export async function runMonitor(
  options: MonitorOptions,
  out: LineSink,
  open: TransportOpener,
): Promise<number> {
  const ids = options.ids ?? [];
  const block = options.block ?? [];
  const flowControl = options.flowControl ?? [];
  const limit = options.idBits === 11 ? MASK_11 : MASK_29;
  for (const canId of [...ids, ...block, ...flowControl]) {
    if (canId < 0 || canId > limit) {
      throw new OptionError(
        `identifier ${hexNumber(canId, 1)} does not fit ${String(options.idBits)} bits`,
      );
    }
  }
  const frameFilter = new MonitorFilter(ids, block, flowControl);
  const sink = await options.output?.open();
  const log = new MonitorLog(
    async (line) => {
      if (sink === undefined) out(line);
      else await sink.write(`${line}\n`);
    },
    options.idBits,
    options.count,
  );
  try {
    const transport = open(options.adapter);
    await transport.open();
    try {
      if (transport instanceof RawCanTransport) {
        await transport.link.configure(options.bitrate, true);
        out("raw CAN link, listen-only: the log is complete");
        await monitorRaw(transport.link, log, frameFilter, options.durationMs);
      } else {
        const elm = new Elm(transport, { transcript: new Transcript(options.transcriptSink) });
        const info = await elm.initialise();
        await elm.selectCan(options.idBits, options.bitrate);
        const kind = info.hasStnExtensions ? "STN filters, no acknowledgement" : "ELM327 filters";
        out(`adapter ${info.identity}, monitoring with ${kind}: the log holds what passes them`);
        await monitorElm(elm, info, log, frameFilter, options.durationMs);
      }
    } finally {
      await transport.close();
    }
  } finally {
    await sink?.close();
  }
  out(
    `${String(log.frames)} frames logged` +
      (options.output === undefined ? "" : ` to ${options.output.label}`),
  );
  return 0;
}
