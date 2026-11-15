/**
 * The app's event log: a short, in-memory record of what the app did, for a problem report.
 *
 * It records kinds and outcomes only. Every field of an {@link AppEvent} is a member of a closed set, a number or a boolean, so a value from the car or the user cannot be put into one by construction: no data values, payloads, VINs, serial numbers, fault codes, adapter names or addresses, device identifiers, file names, share-link fragments or typed text. The log is bounded in count and in size, never written to storage and never sent anywhere.
 */

/** The places the app can be showing. */
export type ScreenId =
  "connect" | "scan" | "live" | "library" | "guide" | "settings" | "shared" | "app";

/** How a connection reaches the car, by transport type only. */
export type TransportKind = "webserial" | "webbluetooth" | "webusb" | "simulator" | "other";

/** Where an error was caught. */
export type ErrorSource = "react" | "window" | "rejection" | "worker" | "rpc";

/**
 * How an operation ended, as a closed set.
 *
 * `ok`; `refused` (the guard or the service said no); `profile-required`; `conflict` (another operation or confirmation is pending); `invalid` (the input was not accepted); `adapter-error` (the adapter or the car did not answer as expected); `timeout`; `cancelled`; `unexpected` (a bug).
 */
export type Outcome =
  | "ok"
  | "refused"
  | "profile-required"
  | "conflict"
  | "invalid"
  | "adapter-error"
  | "timeout"
  | "cancelled"
  | "unexpected";

/** The state of the page's database. */
export type StorageState = "opening" | "ready" | "in-use" | "unsupported" | "failed";

/** What the service worker (the page's offline cache) is doing. */
export type ServiceWorkerState = "controlled" | "uncontrolled" | "unsupported";

/** One thing the app did. */
export type AppEvent =
  | { readonly kind: "screen"; readonly screen: ScreenId }
  | { readonly kind: "connect"; readonly transport: TransportKind }
  | { readonly kind: "disconnect" }
  | { readonly kind: "operation"; readonly name: string; readonly outcome: Outcome }
  | { readonly kind: "storage"; readonly state: StorageState }
  | { readonly kind: "service-worker"; readonly state: ServiceWorkerState }
  | { readonly kind: "error"; readonly source: ErrorSource; readonly screen: ScreenId };

/** An event as stored: when it first happened, and how many times in a row. */
export type LoggedEvent = AppEvent & {
  /** Milliseconds from the log's start to the first of the repeats, rounded to 100. */
  readonly at: number;
  readonly count: number;
};

/** The most events kept. */
export const MAX_EVENTS = 200;

/** The most characters of JSON the kept events may take together. */
export const MAX_EVENT_BYTES = 12_000;

/** An operation name: dotted identifiers, as the client's procedure paths are. */
const OPERATION_NAME = /^[a-z][A-Za-z0-9]{0,30}(?:\.[a-z][A-Za-z0-9]{0,30}){0,3}$/;

/** Whether `name` has the shape of a procedure path, so it can be a code identifier and not text. */
export function isOperationName(name: string): boolean {
  return OPERATION_NAME.test(name);
}

function sameEvent(a: AppEvent, b: AppEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A bounded log of {@link AppEvent}s, oldest first. Repeats of the newest event are counted, not stored again. */
export class EventLog {
  readonly #entries: { event: AppEvent; at: number; count: number; size: number }[] = [];
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #started: number;
  readonly #now: () => number;

  /**
   * @param limits The bounds; the defaults are {@link MAX_EVENTS} and {@link MAX_EVENT_BYTES}.
   * @param now A clock in milliseconds; only differences are used.
   */
  constructor(
    limits: { readonly maxEvents?: number; readonly maxBytes?: number } = {},
    now: () => number = () => performance.now(),
  ) {
    this.#maxEvents = limits.maxEvents ?? MAX_EVENTS;
    this.#maxBytes = limits.maxBytes ?? MAX_EVENT_BYTES;
    this.#now = now;
    this.#started = now();
  }

  /** Adds `event`. An operation whose name is not a procedure path is dropped, so text cannot enter by that route. */
  record(event: AppEvent): void {
    if (event.kind === "operation" && !isOperationName(event.name)) return;
    const newest = this.#entries.at(-1);
    if (newest !== undefined && sameEvent(newest.event, event)) {
      newest.count += 1;
      return;
    }
    const at = Math.round((this.#now() - this.#started) / 100) * 100;
    this.#entries.push({ event, at, count: 1, size: JSON.stringify(event).length + 16 });
    this.#trim();
  }

  #trim(): void {
    let total = this.#entries.reduce((sum, entry) => sum + entry.size, 0);
    while (
      this.#entries.length > this.#maxEvents ||
      (total > this.#maxBytes && this.#entries.length > 1)
    ) {
      const removed = this.#entries.shift();
      if (removed === undefined) return;
      total -= removed.size;
    }
  }

  /** The kept events, oldest first. */
  snapshot(): readonly LoggedEvent[] {
    return this.#entries.map(({ event, at, count }) => ({ ...event, at, count }));
  }

  /** Forgets every event. */
  clear(): void {
    this.#entries.length = 0;
  }
}

/** The app's own log. */
export const appLog = new EventLog();

/** Records `event` in {@link appLog}. */
export function recordEvent(event: AppEvent): void {
  appLog.record(event);
}

/** One event as a line of a report, such as `+1.2s operation scan.run ok x3`. */
export function formatEvent(event: LoggedEvent): string {
  const time = `+${(event.at / 1000).toFixed(1)}s`;
  const repeat = event.count > 1 ? ` x${String(event.count)}` : "";
  switch (event.kind) {
    case "screen":
      return `${time} screen ${event.screen}${repeat}`;
    case "connect":
      return `${time} connect ${event.transport}${repeat}`;
    case "disconnect":
      return `${time} disconnect${repeat}`;
    case "operation":
      return `${time} operation ${event.name} ${event.outcome}${repeat}`;
    case "storage":
      return `${time} storage ${event.state}${repeat}`;
    case "service-worker":
      return `${time} service-worker ${event.state}${repeat}`;
    case "error":
      return `${time} error ${event.source} on ${event.screen}${repeat}`;
  }
}
