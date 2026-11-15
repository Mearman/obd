/**
 * Anonymisation of error text for a problem report.
 *
 * A report is shown to the user and then pasted into a public issue, so everything in it goes through here first. The functions remove what could identify a car, a device, a person or a machine: VIN-shaped words, hexadecimal runs, MAC, IP and email addresses, URLs, file paths and names, adapter and device identifiers, and quoted text. They work on shapes, so a value that has none (a name someone typed) is only removed when it is quoted in the message or listed in {@link ScrubContext.known}.
 *
 * Stack frames are reduced to a function name and an app-relative file and line. A frame from any other origin (an extension, a third-party script) is dropped and counted.
 */

import { redactVinShapes } from "obd-read";

/** What the scrubbers need to know about the running page. */
export interface ScrubContext {
  /** The page's origin, such as `https://example.com`. Only URLs on it keep their origin and path. */
  readonly appOrigin: string;
  /** The path the app is served under, such as `/` or `/obd/`, removed from a frame's file. */
  readonly basePath: string;
  /** Exact values to remove wherever they appear, such as the connected adapter's name and address. */
  readonly known: readonly string[];
}

/** The longest message kept, in characters. */
export const MAX_MESSAGE_LENGTH = 400;

/** The most stack frames kept. */
export const MAX_FRAMES = 15;

const MASKS = {
  text: "[text]",
  url: "[url]",
  email: "[email]",
  address: "[address]",
  path: "[path]",
  file: "[file]",
  hex: "[hex]",
  code: "[code]",
  id: "[id]",
  known: "[redacted]",
  vin: "[vin]",
} as const;

/** Quoted words that name a property or key, which code rather than a person put in the message: `reading 'map'`. */
const KEPT_QUOTE_CONTEXT = /\b(?:reading|setting)\s+$/;

const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g;

const URL_SHAPE =
  /(?:\b(?:blob|filesystem):)?\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]}]*|\b(?:data|javascript):[^\s"'<>`)]+/gi;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const MAC =
  /(?<![0-9a-f:.-])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![0-9a-f:-])|(?<![0-9a-f.])[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}(?![0-9a-f.])/gi;

const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

const WINDOWS_PATH = /(?<![\w])[A-Za-z]:\\[^\s"'<>|*?]*|\\\\[^\s"'<>|*?\\]+(?:\\[^\s"'<>|*?\\]*)*/g;

/** A rooted or home-relative path with at least one segment; a slash after a word character (a date, `and/or`) is not one. */
const UNIX_PATH = /(?<![\w/:.~-])~?\/(?:[\w.@%+~$=,-]+\/)*[\w.@%+~$=,-]+\/?/g;

const FILE_NAME =
  /(?<![\w-])[\w.@%+~$=,-]*\.(?:json|csv|txt|log|toml|ya?ml|xml|ini|db|sqlite3?|zip|gz|pdf|png|jpe?g|gif|bin|hex|dump|obd)(?![\w-])/gi;

const UUID = /(?<![0-9a-f-])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![0-9a-f-])/gi;

/** Four or more hexadecimal bytes written with separators: a frame as an adapter prints it. */
const SPACED_BYTES = /(?<![0-9a-f])(?:[0-9a-f]{2}[ :,-]){3,}[0-9a-f]{2}(?![0-9a-f])/gi;

const HEX_RUN = /(?:0x)?[0-9a-f]{8,}|0x[0-9a-f]{3,}/gi;

/** A fault code (`P0301`, `U0100`). */
const FAULT_CODE = /(?<![A-Za-z0-9])[PCBU][0-3][0-9A-F]{3}(?![A-Za-z0-9])/g;

/** A long base64 or base62 token, such as a browser's device identifier. */
const LONG_TOKEN = /(?<![\w+/=-])[A-Za-z0-9+/_-]{24,}={0,2}(?![\w+/=-])/g;

function maskQuoted(text: string): string {
  return text.replace(QUOTED, (span, offset: number) =>
    KEPT_QUOTE_CONTEXT.test(text.slice(0, offset)) ? span : `"${MASKS.text}"`,
  );
}

/** The scheme and host of a page, or undefined for a value that is not an absolute URL. */
function parseUrl(text: string): URL | undefined {
  return URL.canParse(text) ? new URL(text) : undefined;
}

function scrubUrl(match: string, context: ScrubContext): string {
  // A blob or filesystem URL wraps another URL and is a handle to local data, so it never keeps its origin.
  if (/^(?:blob|filesystem):/i.test(match)) return MASKS.url;
  const parsed = parseUrl(match);
  if (parsed?.origin !== context.appOrigin) return MASKS.url;
  return `${parsed.origin}${parsed.pathname}`;
}

function mask(text: string, pattern: RegExp, replacement: string): string {
  return text.replace(pattern, replacement);
}

function containsLetterAndDigit(word: string): boolean {
  return /[A-Za-z]/.test(word) && /\d/.test(word);
}

function scrubKnown(text: string, known: readonly string[]): string {
  let result = text;
  for (const value of known) {
    if (value.length < 3) continue;
    const lower = value.toLowerCase();
    let at = result.toLowerCase().indexOf(lower);
    while (at !== -1) {
      result = `${result.slice(0, at)}${MASKS.known}${result.slice(at + value.length)}`;
      at = result.toLowerCase().indexOf(lower, at + MASKS.known.length);
    }
  }
  return result;
}

/** Removes VIN-shaped words, hexadecimal runs, fault codes and identifier-like tokens: what can appear even in a function name. */
export function scrubIdentifiers(text: string): string {
  const withoutVin = redactVinShapes(text, MASKS.vin);
  return mask(
    mask(mask(withoutVin, SPACED_BYTES, MASKS.hex), HEX_RUN, MASKS.hex),
    FAULT_CODE,
    MASKS.code,
  );
}

/**
 * `text` with everything {@link ScrubContext} and the shapes above identify removed. The result is not trimmed to a length; see {@link scrubMessage}.
 */
export function scrubText(text: string, context: ScrubContext): string {
  let result = scrubKnown(text, context.known);
  result = maskQuoted(result);
  result = result.replace(URL_SHAPE, (match) => scrubUrl(match, context));
  result = mask(result, EMAIL, MASKS.email);
  result = mask(result, MAC, MASKS.address);
  result = result.replace(IPV6, (match) =>
    match.includes("::") || match.split(":").length > 4 ? MASKS.address : match,
  );
  result = mask(result, IPV4, MASKS.address);
  result = mask(result, WINDOWS_PATH, MASKS.path);
  result = mask(result, UNIX_PATH, MASKS.path);
  result = mask(result, FILE_NAME, MASKS.file);
  result = mask(result, UUID, MASKS.id);
  result = scrubIdentifiers(result);
  result = result.replace(LONG_TOKEN, (word) => (containsLetterAndDigit(word) ? MASKS.id : word));
  // A stray backtick would end the code fence a report puts the text in.
  return result.replaceAll("`", "'");
}

/** An error message scrubbed by {@link scrubText}, on one line and cut to {@link MAX_MESSAGE_LENGTH}. */
export function scrubMessage(message: string, context: ScrubContext): string {
  const line = scrubText(message, context).replace(/\s+/g, " ").trim();
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH)}...` : line;
}

const ERROR_NAME = /^[A-Za-z_$][\w$.]{0,59}$/;

/** An error's name when it has the shape of an identifier, else `Error`: a name is code, but nothing else is promised of one. */
export function scrubName(name: string): string {
  return ERROR_NAME.test(name) ? scrubIdentifiers(name) : "Error";
}

/** One stack frame after reduction. */
export interface Frame {
  /** The function name, or `<anonymous>`. */
  readonly name: string;
  /** The file relative to the app's base path. */
  readonly file: string;
  readonly line: number;
}

/** A stack after reduction. */
export interface ScrubbedStack {
  readonly frames: readonly Frame[];
  /** How many frames were dropped because they were not in the app. */
  readonly omitted: number;
}

const LOCATION = /^(.*?):(\d+)(?::\d+)?$/;
const FUNCTION_NAME = /^[\w$.<>\s[\]-]{1,80}$/;

function splitFrame(
  line: string,
): { readonly name: string; readonly location: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("at ")) {
    const body = trimmed.slice(3);
    if (body.endsWith(")")) {
      const open = body.lastIndexOf(" (");
      if (open !== -1) return { name: body.slice(0, open), location: body.slice(open + 2, -1) };
    }
    return { name: "<anonymous>", location: body };
  }
  const at = trimmed.indexOf("@");
  if (at !== -1 && /:\d+(?::\d+)?$/.test(trimmed)) {
    return { name: trimmed.slice(0, at) || "<anonymous>", location: trimmed.slice(at + 1) };
  }
  return undefined;
}

function appFile(url: string, context: ScrubContext): string | undefined {
  const parsed = parseUrl(url);
  if (parsed?.origin !== context.appOrigin) return undefined;
  const path = parsed.pathname.startsWith(context.basePath)
    ? parsed.pathname.slice(context.basePath.length)
    : parsed.pathname.replace(/^\//, "");
  return /^[\w./-]+$/.test(path) ? path : undefined;
}

/** The frames of a stack that lie in the app, each as function name, file and line; every other frame is counted and dropped. */
export function scrubStack(stack: string | undefined, context: ScrubContext): ScrubbedStack {
  const frames: Frame[] = [];
  let omitted = 0;
  for (const line of (stack ?? "").split("\n")) {
    const parts = splitFrame(line);
    if (parts === undefined) continue;
    const located = LOCATION.exec(parts.location);
    const file = located?.[1] === undefined ? undefined : appFile(located[1], context);
    if (located?.[2] === undefined || file === undefined) {
      omitted += 1;
      continue;
    }
    if (frames.length >= MAX_FRAMES) {
      omitted += 1;
      continue;
    }
    const name = FUNCTION_NAME.test(parts.name)
      ? scrubIdentifiers(parts.name.trim())
      : "<anonymous>";
    frames.push({ name, file, line: Number(located[2]) });
  }
  return { frames, omitted };
}

/** The browser as family and major version, and the operating system as family only. */
export interface BrowserSummary {
  readonly browser: string;
  readonly os: string;
}

function major(userAgent: string, pattern: RegExp): string | undefined {
  return pattern.exec(userAgent)?.[1];
}

function browserOf(userAgent: string): string {
  const candidates: readonly (readonly [string, RegExp])[] = [
    ["Edge", /\bEdgA?\/(\d+)/],
    ["Opera", /\bOPR\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    // No leading boundary: a headless browser says HeadlessChrome.
    ["Chrome", /(?:Chrome|CriOS|Chromium)\/(\d+)/],
    ["Safari", /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [family, pattern] of candidates) {
    const version = major(userAgent, pattern);
    if (version !== undefined) return `${family} ${version}`;
  }
  return "Unknown browser";
}

function osOf(userAgent: string, maxTouchPoints: number): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (userAgent.includes("Macintosh")) return maxTouchPoints > 1 ? "iOS" : "macOS";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("CrOS")) return "ChromeOS";
  if (userAgent.includes("Windows")) return "Windows";
  if (userAgent.includes("Linux")) return "Linux";
  return "Unknown OS";
}

/** Reduces a user agent string to what a report keeps of it: no build numbers, devices or models. */
export function summariseBrowser(userAgent: string, maxTouchPoints = 0): BrowserSummary {
  return { browser: browserOf(userAgent), os: osOf(userAgent, maxTouchPoints) };
}
