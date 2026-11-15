import { ORPCError } from "@orpc/client";
import { TransportError, TransportTimeout } from "obd-read";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsError } from "../src/diagnostics/client";
import {
  ErrorStore,
  classifyFailure,
  installGlobalHandlers,
  observeClient,
  reportCall,
  type CapturedError,
} from "../src/report/capture";
import { appLog, type Outcome } from "../src/report/events";

function captured(store: ErrorStore): CapturedError | undefined {
  return store.getState().latest;
}

describe("ErrorStore", () => {
  it("keeps the latest error and queues a notice only for one nothing showed", () => {
    const store = new ErrorStore();
    store.setScreen("runs");
    store.capture("window", new TypeError("late"), false);
    expect(captured(store)).toMatchObject({
      source: "window",
      screen: "runs",
      name: "TypeError",
      message: "late",
    });
    expect(store.getState().pending).toBe(captured(store));

    const handled = new Error("shown by a boundary");
    store.capture("react", handled, true, "scan");
    expect(captured(store)).toMatchObject({ source: "react", screen: "scan" });
    expect(store.getState().pending).toMatchObject({ message: "late" });
    store.dismiss();
    expect(store.getState().pending).toBeUndefined();
    expect(captured(store)).toMatchObject({ message: "shown by a boundary" });
  });

  it("counts one error object once, however many routes see it", () => {
    const store = new ErrorStore();
    const error = new Error("once");
    const listener = vi.fn();
    store.subscribe(listener);
    store.capture("react", error, true);
    store.capture("window", error, false);
    store.capture("rejection", error, false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().pending).toBeUndefined();
  });

  it("describes a thrown value that is not an error without keeping it", () => {
    const store = new ErrorStore();
    store.capture("rejection", { secret: "WDB2110202B121724" }, false);
    expect(captured(store)).toMatchObject({ name: "NonError", message: "a object was thrown" });
    store.capture("rejection", "text", false);
    expect(captured(store)).toMatchObject({ name: "NonError", message: "text" });
  });

  it("stops calling a listener that unsubscribed, and returns the same state until a change", () => {
    const store = new ErrorStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const before = store.getState();
    expect(store.getState()).toBe(before);
    stop();
    store.capture("window", new Error("x"), false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("classifyFailure", () => {
  const cases: readonly (readonly [string, unknown, Outcome])[] = [
    ["a refused guard request", new ORPCError("FORBIDDEN"), "refused"],
    ["a missing profile", new ORPCError("PROFILE_REQUIRED"), "profile-required"],
    ["a busy link", new ORPCError("CONFLICT"), "conflict"],
    ["nothing connected", new ORPCError("PRECONDITION_FAILED"), "conflict"],
    ["a bad input", new ORPCError("BAD_REQUEST"), "invalid"],
    ["an unknown id", new ORPCError("NOT_FOUND"), "invalid"],
    ["an adapter failure", new ORPCError("BAD_GATEWAY"), "adapter-error"],
    ["a gateway timeout", new ORPCError("GATEWAY_TIMEOUT"), "timeout"],
    ["a server bug", new ORPCError("INTERNAL_SERVER_ERROR"), "unexpected"],
    ["an unknown code", new ORPCError("SOMETHING_NEW"), "unexpected"],
    ["a transport timeout", new TransportTimeout("slow"), "timeout"],
    ["a transport error", new TransportError("gone"), "adapter-error"],
    ["the app's own refusal", new DiagnosticsError("no"), "invalid"],
    ["an abort", new DOMException("stopped", "AbortError"), "cancelled"],
    ["a TypeError", new TypeError("bug"), "unexpected"],
    ["a string", "bug", "unexpected"],
  ];

  it.each(cases)("%s", (_name, error, outcome) => {
    expect(classifyFailure(error)).toBe(outcome);
  });
});

describe("observeClient", () => {
  function fakeClient() {
    return {
      link: { status: () => Promise.resolve(null) },
      scan: {
        run: (...input: unknown[]) =>
          Promise.reject(new ORPCError("FORBIDDEN", { data: input.length })),
      },
      runs: {
        start: () => Promise.reject(new TypeError("a bug")),
        list: (): string[] => [],
      },
      label: "plain value",
    };
  }

  it("reports each call's procedure path and outcome, and nothing else", async () => {
    const seen: [string, Outcome][] = [];
    const client = observeClient(fakeClient(), (name, outcome) => {
      seen.push([name, outcome]);
    });
    await client.link.status();
    await expect(client.scan.run({ secret: "WDB2110202B121724" })).rejects.toBeInstanceOf(
      ORPCError,
    );
    await expect(client.runs.start()).rejects.toBeInstanceOf(TypeError);
    await Promise.resolve();
    expect(seen).toEqual([
      ["link.status", "ok"],
      ["scan.run", "refused"],
      ["runs.start", "unexpected"],
    ]);
    expect(JSON.stringify(seen)).not.toContain("WDB");
  });

  it("returns what the call returned, untouched", async () => {
    const promise = Promise.resolve("value");
    const base = { thing: { call: () => promise, sync: () => 42 }, label: "x" };
    const names: string[] = [];
    const client = observeClient(base, (name) => {
      names.push(name);
    });
    expect(client.thing.call()).toBe(promise);
    expect(client.thing.sync()).toBe(42);
    expect(client.label).toBe("x");
    await promise;
    // Only the call that returned a promise has an outcome.
    expect(names).toEqual(["thing.call"]);
  });

  it("logs expected failures as events and captures only a bug", async () => {
    appLog.clear();
    const store = new ErrorStore();
    const client = observeClient(fakeClient(), reportCall(store));
    await expect(client.scan.run({})).rejects.toBeInstanceOf(ORPCError);
    await Promise.resolve();
    expect(store.getState()).toEqual({ latest: undefined, pending: undefined });
    expect(appLog.snapshot()).toMatchObject([
      { kind: "operation", name: "scan.run", outcome: "refused" },
    ]);

    await expect(client.runs.start()).rejects.toBeInstanceOf(TypeError);
    await Promise.resolve();
    expect(captured(store)).toMatchObject({ source: "rpc", name: "TypeError", message: "a bug" });
    expect(store.getState().pending).toBeDefined();
  });
});

describe("installGlobalHandlers", () => {
  function setup() {
    const target = new EventTarget();
    const store = new ErrorStore();
    const stop = installGlobalHandlers(target, store);
    return { target, store, stop };
  }

  function rejection(reason: unknown): Event {
    return Object.assign(new Event("unhandledrejection"), { reason });
  }

  it("captures an uncaught error with its error object", () => {
    const { target, store } = setup();
    target.dispatchEvent(
      new ErrorEvent("error", { message: "boom", error: new RangeError("boom") }),
    );
    expect(captured(store)).toMatchObject({
      source: "window",
      name: "RangeError",
      message: "boom",
    });
    expect(store.getState().pending).toBeDefined();
  });

  it("captures an uncaught error that has no error object, with where it came from", () => {
    const { target, store } = setup();
    target.dispatchEvent(
      new ErrorEvent("error", {
        message: "Script error.",
        filename: "https://example.test/obd/a.js",
        lineno: 4,
        colno: 9,
      }),
    );
    expect(captured(store)).toMatchObject({
      name: "Error",
      message: "Script error.",
      stack: "at <anonymous> (https://example.test/obd/a.js:4:9)",
    });
  });

  it("captures an unhandled rejection", () => {
    const { target, store } = setup();
    target.dispatchEvent(rejection(new Error("lost")));
    expect(captured(store)).toMatchObject({ source: "rejection", message: "lost" });
  });

  it("ignores a rejection that is an expected typed error, and the benign resize notice", () => {
    const { target, store } = setup();
    target.dispatchEvent(rejection(new ORPCError("FORBIDDEN", { message: "the guard said no" })));
    target.dispatchEvent(rejection(new ORPCError("PROFILE_REQUIRED")));
    target.dispatchEvent(
      new ErrorEvent("error", {
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    );
    expect(captured(store)).toBeUndefined();
  });

  it("stops after it is uninstalled", () => {
    const { target, store, stop } = setup();
    stop();
    target.dispatchEvent(new ErrorEvent("error", { message: "late", error: new Error("late") }));
    target.dispatchEvent(rejection(new Error("late")));
    expect(captured(store)).toBeUndefined();
  });
});
