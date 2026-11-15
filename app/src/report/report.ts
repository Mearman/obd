/**
 * The problem report: a title and a body, built from a captured error, the event log and the environment, all anonymised, and the link that opens GitHub's new-issue form with them.
 *
 * Nothing here sends anything. The report is text the user reads in a dialog, copies or downloads, and the link is an address the user chooses to open.
 */

import {
  scrubMessage,
  scrubName,
  scrubStack,
  summariseBrowser,
  type ScrubContext,
} from "./anonymise";
import type { CapturedError } from "./capture";
import {
  formatEvent,
  type LoggedEvent,
  type ServiceWorkerState,
  type StorageState,
} from "./events";
import { NEW_ISSUE_URL } from "./repository";

/** What the report says about the page it came from. Every field is a flag, a version or a family. */
export interface ReportEnvironment {
  readonly version: string;
  readonly build: string;
  /** The raw user agent; only its family and major version leave {@link buildReport}. */
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly flags: {
    readonly webSerial: boolean;
    readonly webBluetooth: boolean;
    readonly webUsb: boolean;
    readonly secureContext: boolean;
    readonly standalone: boolean;
    readonly opfs: boolean;
    readonly serviceWorker: ServiceWorkerState;
    readonly storage: StorageState;
  };
}

/** What a report is made from. */
export interface ReportInput {
  readonly error: CapturedError;
  readonly events: readonly LoggedEvent[];
  readonly environment: ReportEnvironment;
}

/** A report, ready to show and to put in an issue. */
export interface Report {
  readonly title: string;
  /** The events, newest last, as report lines. */
  readonly eventLines: readonly string[];
  /** The issue body with the newest `keep` events, and a note when older ones are left out. */
  readonly body: (keep: number) => string;
  /** The title and the whole body, for copying and downloading. */
  readonly text: string;
}

const MAX_TITLE_LENGTH = 100;

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** The environment lines of a report. */
function environmentLines(environment: ReportEnvironment): string[] {
  const { browser, os } = summariseBrowser(environment.userAgent, environment.maxTouchPoints);
  const { flags } = environment;
  return [
    `- App: ${environment.version} (build ${environment.build})`,
    `- Browser: ${browser} on ${os}`,
    `- Web Serial: ${yesNo(flags.webSerial)}, Web Bluetooth: ${yesNo(flags.webBluetooth)}, WebUSB: ${yesNo(flags.webUsb)}`,
    `- Secure context: ${yesNo(flags.secureContext)}, installed app: ${yesNo(flags.standalone)}, OPFS: ${yesNo(flags.opfs)}`,
    `- Service worker: ${flags.serviceWorker}, storage: ${flags.storage}`,
  ];
}

function errorLines(error: CapturedError, context: ScrubContext): string[] {
  const { frames, omitted } = scrubStack(error.stack, context);
  const lines = [`${scrubName(error.name)}: ${scrubMessage(error.message, context)}`];
  for (const frame of frames)
    lines.push(`    at ${frame.name} (${frame.file}:${String(frame.line)})`);
  if (omitted > 0) lines.push(`    ${String(omitted)} frames outside the app are left out`);
  return lines;
}

const SCREEN_NAMES = {
  connect: "Connect",
  scan: "Scan",
  live: "Live",
  runs: "Runs",
  captures: "Captures",
  settings: "Settings",
  shared: "shared data",
  app: "app",
} as const;

const SOURCE_NAMES = {
  react: "while showing a screen",
  window: "outside any screen",
  rejection: "in a task that nothing was waiting on",
  worker: "in a background worker",
  rpc: "in a request to the diagnostic service",
} as const;

/** Builds a report from `input`, scrubbing every text with `context`. */
export function buildReport(input: ReportInput, context: ScrubContext): Report {
  const { error } = input;
  const eventLines = input.events.map(formatEvent);
  const errorText = errorLines(error, context).join("\n");
  const environmentText = environmentLines(input.environment).join("\n");
  const heading = `App error on ${SCREEN_NAMES[error.screen]}: ${errorText.split("\n")[0] ?? "Error"}`;
  const title =
    heading.length > MAX_TITLE_LENGTH ? `${heading.slice(0, MAX_TITLE_LENGTH - 3)}...` : heading;

  const body = (keep: number): string => {
    const kept = eventLines.slice(Math.max(0, eventLines.length - keep));
    const left = eventLines.length - kept.length;
    const note =
      left > 0
        ? `The ${String(left)} oldest of ${String(eventLines.length)} events are left out so the link fits.\n\n`
        : "";
    return [
      "## What happened",
      "",
      `The app caught an unexpected error ${SOURCE_NAMES[error.source]} on the ${SCREEN_NAMES[error.screen]} screen. Add what you were doing just before it, if you can.`,
      "",
      "## Error",
      "",
      "```text",
      errorText,
      "```",
      "",
      "## Environment",
      "",
      environmentText,
      "",
      "## Recent events",
      "",
      `${note}\`\`\`text`,
      kept.length === 0 ? "(none)" : kept.join("\n"),
      "```",
      "",
      "Kinds and outcomes only: no readings, VINs, serial numbers, fault codes, adapter names or addresses, file names or typed text.",
    ].join("\n");
  };
  return { title, eventLines, body, text: `${title}\n\n${body(eventLines.length)}` };
}

/**
 * The longest link the app opens, in characters. GitHub answers a request line past about 8 KiB with an error, and a proxy in front may allow less, so this leaves room.
 */
export const MAX_URL_LENGTH = 6000;

/** The body used when even the shortest report does not fit in a link. */
export const CLIPBOARD_BODY =
  "The report was too long for a link, so it was copied to your clipboard. Paste it here, replacing this line.";

/** How a link carries its report. */
export type LinkMode = "full" | "truncated" | "clipboard";

/** The link that opens GitHub's new-issue form with a report. */
export interface IssueLink {
  readonly url: string;
  /** The body the link carries, which the dialog shows. */
  readonly body: string;
  readonly mode: LinkMode;
  /** How many events the link leaves out. */
  readonly omittedEvents: number;
}

function linkFor(title: string, body: string): string {
  const query = new URLSearchParams({ title, body, labels: "bug" });
  return `${NEW_ISSUE_URL}?${query.toString()}`;
}

/**
 * The link for `report`. Older events are left out first, as many as it takes to stay within `maxLength`; when the report is too long even with no events, the link carries {@link CLIPBOARD_BODY} and the caller puts the whole report on the clipboard.
 */
export function buildIssueLink(report: Report, maxLength: number = MAX_URL_LENGTH): IssueLink {
  const total = report.eventLines.length;
  const fits = (keep: number): boolean =>
    linkFor(report.title, report.body(keep)).length <= maxLength;
  if (!fits(0)) {
    return {
      url: linkFor(report.title, CLIPBOARD_BODY),
      body: CLIPBOARD_BODY,
      mode: "clipboard",
      omittedEvents: total,
    };
  }
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const body = report.body(low);
  return {
    url: linkFor(report.title, body),
    body,
    mode: low === total ? "full" : "truncated",
    omittedEvents: total - low,
  };
}
