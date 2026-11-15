import { describe, expect, it } from "vitest";
import type { ScrubContext } from "../src/report/anonymise";
import type { CapturedError } from "../src/report/capture";
import type { LoggedEvent } from "../src/report/events";
import {
  CLIPBOARD_BODY,
  MAX_URL_LENGTH,
  buildIssueLink,
  buildReport,
  type ReportEnvironment,
  type ReportInput,
} from "../src/report/report";
import { NEW_ISSUE_URL } from "../src/report/repository";

const CONTEXT: ScrubContext = {
  appOrigin: "https://example.test",
  basePath: "/obd/",
  known: ["OBDII Veepeak"],
};

const VIN = "WDB2110200A000000";

const ENVIRONMENT: ReportEnvironment = {
  version: "1.2.3",
  build: "abc123def456",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36",
  maxTouchPoints: 0,
  flags: {
    webSerial: true,
    webBluetooth: true,
    webUsb: false,
    secureContext: true,
    standalone: false,
    opfs: true,
    serviceWorker: "controlled",
    storage: "ready",
  },
};

const ERROR: CapturedError = {
  source: "react",
  screen: "scan",
  name: "TypeError",
  message: `Cannot read properties of undefined (reading 'map') for ${VIN} from OBDII Veepeak at 00:1A:7D:DA:71:13 payload 7E8 10 14 49 02 01 57 44 42 in /Users/someone/scan.json`,
  stack: [
    "TypeError: x",
    "    at ScanResultsTable (https://example.test/obd/assets/index-AbC123.js:10:20)",
    "    at lib (https://cdn.example/lib.js:5:5)",
  ].join("\n"),
};

function events(count: number): LoggedEvent[] {
  return Array.from({ length: count }, (_value, index) => ({
    kind: "operation" as const,
    name: `op${String(index % 7)}x${String(index)}`.replace(/\d+$/, (digits) =>
      String.fromCharCode(97 + (Number(digits) % 26)),
    ),
    outcome: "ok" as const,
    at: index * 100,
    count: 1,
  }));
}

function input(logged: readonly LoggedEvent[]): ReportInput {
  return { error: ERROR, events: logged, environment: ENVIRONMENT };
}

const LOGGED: readonly LoggedEvent[] = [
  { kind: "screen", screen: "connect", at: 0, count: 1 },
  { kind: "storage", state: "ready", at: 100, count: 1 },
  { kind: "connect", transport: "simulator", at: 1200, count: 1 },
  { kind: "operation", name: "scan.run", outcome: "ok", at: 2000, count: 1 },
  { kind: "operation", name: "guarded.request", outcome: "refused", at: 3100, count: 2 },
  { kind: "error", source: "react", screen: "scan", at: 3200, count: 1 },
];

describe("buildReport", () => {
  it("is the golden report for a full error", () => {
    const report = buildReport(input(LOGGED), CONTEXT);
    expect(report.title).toBe(
      "App error on Scan: TypeError: Cannot read properties of undefined (reading 'map') for [vin] from ...",
    );
    expect(report.body(LOGGED.length)).toBe(
      [
        "## What happened",
        "",
        "The app caught an unexpected error while showing a screen on the Scan screen. Add what you were doing just before it, if you can.",
        "",
        "## Error",
        "",
        "```text",
        "TypeError: Cannot read properties of undefined (reading 'map') for [vin] from [redacted] at [address] payload 7E8 [hex] in [path]",
        "    at ScanResultsTable (assets/index-AbC123.js:10)",
        "    1 frames outside the app are left out",
        "```",
        "",
        "## Environment",
        "",
        "- App: 1.2.3 (build abc123def456)",
        "- Browser: Chrome 142 on macOS",
        "- Web Serial: yes, Web Bluetooth: yes, WebUSB: no",
        "- Secure context: yes, installed app: no, OPFS: yes",
        "- Service worker: controlled, storage: ready",
        "",
        "## Recent events",
        "",
        "```text",
        "+0.0s screen connect",
        "+0.1s storage ready",
        "+1.2s connect simulator",
        "+2.0s operation scan.run ok",
        "+3.1s operation guarded.request refused x2",
        "+3.2s error react on scan",
        "```",
        "",
        "Kinds and outcomes only: no readings, VINs, serial numbers, fault codes, adapter names or addresses, file names or typed text.",
      ].join("\n"),
    );
  });

  it("carries nothing of the raw error or the user agent", () => {
    const text = buildReport(input(LOGGED), CONTEXT).text;
    for (const secret of [
      VIN,
      "OBDII Veepeak",
      "00:1A:7D:DA:71:13",
      "7E8 10 14",
      "someone",
      "scan.json",
      "Intel",
      "142.0.7444",
      "cdn.example",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("says when there are no events", () => {
    expect(buildReport(input([]), CONTEXT).body(0)).toContain("```text\n(none)\n```");
  });

  it("leaves out the oldest events first and says so", () => {
    const report = buildReport(input(events(10)), CONTEXT);
    const body = report.body(3);
    expect(body).toContain("The 7 oldest of 10 events are left out so the link fits.");
    expect(body.split("\n").filter((line) => line.startsWith("+"))).toEqual(
      report.eventLines.slice(-3),
    );
  });
});

describe("buildIssueLink", () => {
  function parse(url: string): URL {
    return new URL(url);
  }

  it("opens the new-issue form with the title, body and bug label", () => {
    const report = buildReport(input(LOGGED), CONTEXT);
    const link = buildIssueLink(report);
    const url = parse(link.url);
    expect(`${url.origin}${url.pathname}`).toBe(NEW_ISSUE_URL);
    expect(url.searchParams.get("title")).toBe(report.title);
    expect(url.searchParams.get("body")).toBe(report.body(LOGGED.length));
    expect(url.searchParams.get("labels")).toBe("bug");
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "labels", "title"]);
    expect(link).toMatchObject({ mode: "full", omittedEvents: 0 });
  });

  it("round-trips unusual characters through the query", () => {
    const odd: CapturedError = {
      ...ERROR,
      message: "50% done & #1 + more = ? é 中文 🚀 <b>\r\n tab\t",
    };
    const report = buildReport({ error: odd, events: [], environment: ENVIRONMENT }, CONTEXT);
    const link = buildIssueLink(report);
    const url = parse(link.url);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("title")).toBe(report.title);
    expect(url.searchParams.get("body")).toBe(report.body(0));
    expect(link.url).not.toMatch(/[\s<>"{}|\\^`]/);
  });

  it("keeps the link within the limit by leaving out the oldest events, and marks it", () => {
    const report = buildReport(input(events(400)), CONTEXT);
    const link = buildIssueLink(report);
    expect(link.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(link.mode).toBe("truncated");
    expect(link.omittedEvents).toBeGreaterThan(0);
    expect(link.omittedEvents).toBeLessThan(400);
    expect(link.body).toContain(
      `The ${String(link.omittedEvents)} oldest of 400 events are left out`,
    );
    // The newest event is always kept, and one more would not have fitted.
    expect(link.body).toContain(report.eventLines.at(-1) ?? "never");
    const kept = 400 - link.omittedEvents;
    expect(buildIssueLink(report, MAX_URL_LENGTH).url).toBe(buildIssueLink(report).url);
    const next = new URLSearchParams({
      title: report.title,
      body: report.body(kept + 1),
      labels: "bug",
    });
    expect(`${NEW_ISSUE_URL}?${next.toString()}`.length).toBeGreaterThan(MAX_URL_LENGTH);
  });

  it("asks for a paste from the clipboard when even a report with no events does not fit", () => {
    const report = buildReport(input(events(5)), CONTEXT);
    const link = buildIssueLink(report, 300);
    expect(link.mode).toBe("clipboard");
    expect(link.body).toBe(CLIPBOARD_BODY);
    expect(link.url.length).toBeLessThanOrEqual(600);
    expect(parse(link.url).searchParams.get("body")).toBe(CLIPBOARD_BODY);
    expect(parse(link.url).searchParams.get("labels")).toBe("bug");
  });
});
