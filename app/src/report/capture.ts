/**
 * Where errors are caught and how they reach one report.
 *
 * React's error boundaries catch render errors only. This module adds what they cannot see: `error` and `unhandledrejection` events on the window, errors of the page's workers, and service calls that fail in a way the UI does not expect. Every route ends in one {@link ErrorStore}, which keeps the latest error for the report and tells the interface about errors no boundary handled.
 *
 * Expected failures stay ordinary UI states: a refused guard request, a missing profile or an adapter that did not answer is an {@link Outcome} the screens show in their own words, and it is logged as an event but never captured as an error.
 */

import { ORPCError } from "@orpc/client";
import { PROFILE_REQUIRED_CODE, TransportError, TransportTimeout } from "obd-read";
import { DiagnosticsError } from "../diagnostics/client";
import { recordEvent, type ErrorSource, type Outcome, type ScreenId } from "./events";

/** An error as the report builder needs it. It stays in memory and is anonymised only when a report is made. */
export interface CapturedError {
  readonly source: ErrorSource;
  /** The screen the user was on when it was caught. */
  readonly screen: ScreenId;
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

/** What the interface needs of the store. */
export interface ErrorState {
  /** The latest error caught, for the report. */
  readonly latest: CapturedError | undefined;
  /** An error no boundary showed, waiting for the user to report or dismiss it. */
  readonly pending: CapturedError | undefined;
}

type Listener = () => void;

/** The detail of a thrown value, whatever was thrown. */
function describeThrown(thrown: unknown): Pick<CapturedError, "name" | "message" | "stack"> {
  if (thrown instanceof Error) {
    return { name: thrown.name, message: thrown.message, stack: thrown.stack };
  }
  return {
    name: "NonError",
    message: typeof thrown === "string" ? thrown : `a ${typeof thrown} was thrown`,
    stack: undefined,
  };
}

/** The latest captured error and the one awaiting the user. Safe to share: it holds no listeners but the interface's. */
export class ErrorStore {
  #state: ErrorState = { latest: undefined, pending: undefined };
  readonly #listeners = new Set<Listener>();
  readonly #seen = new WeakSet<object>();
  #screen: ScreenId = "app";

  /** Names the screen shown now, so an error caught outside a boundary says where it happened. */
  setScreen(screen: ScreenId): void {
    this.#screen = screen;
  }

  /** The screen set by {@link setScreen}. */
  get screen(): ScreenId {
    return this.#screen;
  }

  /**
   * Records that `thrown` was caught by `source` and makes it the latest error. An object already captured is ignored, so a boundary and the window handler that both see one error count it once. `handled` is true when the interface already shows the failure (a boundary's fallback), so no notice is queued.
   */
  capture(source: ErrorSource, thrown: unknown, handled: boolean, screen = this.#screen): void {
    if (typeof thrown === "object" && thrown !== null) {
      if (this.#seen.has(thrown)) return;
      this.#seen.add(thrown);
    }
    this.captureDetails({ source, screen, ...describeThrown(thrown) }, handled);
  }

  /** Records an error given as detail, for a failure that arrives as an event with no error object. */
  captureDetails(error: CapturedError, handled: boolean): void {
    recordEvent({ kind: "error", source: error.source, screen: error.screen });
    this.#state = { latest: error, pending: handled ? this.#state.pending : error };
    this.#emit();
  }

  /** Clears the pending error, keeping the latest for the report. */
  dismiss(): void {
    if (this.#state.pending === undefined) return;
    this.#state = { ...this.#state, pending: undefined };
    this.#emit();
  }

  /** The current state; the same object until something changes. */
  getState = (): ErrorState => this.#state;

  /** Calls `listener` after each change; returns the function that stops it. */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** The app's error store. */
export const errorStore = new ErrorStore();

/** The outcome of a failed service call, from what the failure is. */
export function classifyFailure(error: unknown): Outcome {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "FORBIDDEN":
        return "refused";
      case PROFILE_REQUIRED_CODE:
        return "profile-required";
      case "CONFLICT":
      case "PRECONDITION_FAILED":
        return "conflict";
      case "BAD_REQUEST":
      case "NOT_FOUND":
        return "invalid";
      case "BAD_GATEWAY":
        return "adapter-error";
      case "TIMEOUT":
      case "GATEWAY_TIMEOUT":
        return "timeout";
      default:
        return "unexpected";
    }
  }
  if (error instanceof TransportTimeout) return "timeout";
  if (error instanceof TransportError) return "adapter-error";
  if (error instanceof DiagnosticsError) return "invalid";
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return "unexpected";
}

/** Called for each settled call of an observed client. */
export type CallObserver = (name: string, outcome: Outcome, error: unknown) => void;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function observe<T extends object>(target: T, path: readonly string[], observer: CallObserver): T {
  return new Proxy(target, {
    get(inner, property) {
      const value: unknown = Reflect.get(inner, property);
      if (typeof property !== "string") return value;
      if (typeof value === "function" || (typeof value === "object" && value !== null)) {
        return observe(value, [...path, property], observer);
      }
      return value;
    },
    apply(inner, thisArg: unknown, args: unknown[]) {
      if (typeof inner !== "function")
        throw new TypeError("a call on something that is not a function");
      const result: unknown = Reflect.apply(inner, thisArg, args);
      if (isThenable(result)) {
        const name = path.join(".");
        // A side chain: the caller keeps the original promise, so its type and its rejection are unchanged.
        result.then(
          () => {
            observer(name, "ok", undefined);
          },
          (error: unknown) => {
            observer(name, classifyFailure(error), error);
          },
        );
      }
      return result;
    },
  });
}

/**
 * A client that behaves as `client` and tells `observer` how each call ended. The names are procedure paths such as `scan.run`; arguments and results are never passed on.
 */
export function observeClient<T extends object>(client: T, observer: CallObserver): T {
  return observe(client, [], observer);
}

/** The observer the app uses: log the outcome, and capture a failure that is a bug. */
export function reportCall(store: ErrorStore): CallObserver {
  return (name, outcome, error) => {
    recordEvent({ kind: "operation", name, outcome });
    if (outcome === "unexpected") store.capture("rpc", error, false);
  };
}

/** The start of a message the browser raises for a harmless reason, which is not a problem to report. */
const BENIGN_MESSAGE_START = "ResizeObserver loop";

/** The error of a worker's or window's `error` event, which may carry no error object. */
export function captureErrorEvent(store: ErrorStore, source: ErrorSource, event: ErrorEvent): void {
  if (event.message.startsWith(BENIGN_MESSAGE_START)) return;
  if (event.error instanceof Error) {
    store.capture(source, event.error, false);
    return;
  }
  const where =
    event.filename === ""
      ? ""
      : `at <anonymous> (${event.filename}:${String(event.lineno)}:${String(event.colno)})`;
  store.captureDetails(
    {
      source,
      screen: store.screen,
      name: "Error",
      message: event.message,
      stack: where === "" ? undefined : where,
    },
    false,
  );
}

/**
 * Starts reporting the window's uncaught errors and unhandled promise rejections to `store`. Returns the function that stops it.
 */
export function installGlobalHandlers(target: EventTarget, store: ErrorStore): () => void {
  const onError = (event: Event): void => {
    if (event instanceof ErrorEvent) captureErrorEvent(store, "window", event);
  };
  const onRejection = (event: Event): void => {
    const reason: unknown = "reason" in event ? event.reason : undefined;
    // A refused request or a missing profile that a screen left uncaught is still an expected state.
    if (classifyFailure(reason) === "unexpected") store.capture("rejection", reason, false);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
