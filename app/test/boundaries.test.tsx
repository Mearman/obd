import { ORPCError } from "@orpc/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type * as ConnectScreenModule from "../src/screens/ConnectScreen";
import type * as ScanScreenModule from "../src/screens/ScanScreen";
import type * as LiveScreenModule from "../src/screens/LiveScreen";
import type * as RunsScreenModule from "../src/screens/RunsScreen";
import type * as SettingsScreenModule from "../src/screens/SettingsScreen";
import type { BrowserSupport } from "../src/connect/support";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import { ErrorStore, observeClient, reportCall } from "../src/report/capture";
import { ErrorBoundary, RootBoundary, ScreenFallback } from "../src/report/ErrorBoundary";
import { appLog } from "../src/report/events";
import { ReportHost } from "../src/report/ReportHost";
import { createTestService, renderApp } from "./render";

/** The screens that are made to throw, by name. */
const failing = vi.hoisted(() => new Set<string>());

vi.mock("../src/screens/ConnectScreen", async (original) => {
  const real = await original<typeof ConnectScreenModule>();
  return {
    ConnectScreen: (props: Parameters<typeof real.ConnectScreen>[0]) => {
      if (failing.has("connect")) throw new Error("connect failed");
      return real.ConnectScreen(props);
    },
  };
});
vi.mock("../src/screens/ScanScreen", async (original) => {
  const real = await original<typeof ScanScreenModule>();
  return {
    ScanScreen: () => {
      if (failing.has("scan")) throw new Error("scan failed");
      return real.ScanScreen();
    },
  };
});
vi.mock("../src/screens/LiveScreen", async (original) => {
  const real = await original<typeof LiveScreenModule>();
  return {
    LiveScreen: () => {
      if (failing.has("live")) throw new Error("live failed");
      return real.LiveScreen();
    },
  };
});
vi.mock("../src/screens/RunsScreen", async (original) => {
  const real = await original<typeof RunsScreenModule>();
  return {
    RunsScreen: () => {
      if (failing.has("runs")) throw new Error("runs failed");
      return real.RunsScreen();
    },
  };
});
vi.mock("../src/screens/SettingsScreen", async (original) => {
  const real = await original<typeof SettingsScreenModule>();
  return {
    SettingsScreen: () => {
      if (failing.has("settings")) throw new Error("settings failed");
      return real.SettingsScreen();
    },
  };
});
vi.mock("../src/share/SharedViewer", () => ({
  SharedViewer: () => {
    if (failing.has("shared")) throw new Error("shared failed");
    return <h1>Shared viewer</h1>;
  },
}));

const SUPPORT: BrowserSupport = {
  family: "chromium",
  capabilities: {
    webSerial: true,
    webBluetooth: true,
    webUsb: true,
    secureContext: true,
    usable: true,
    issues: [],
  },
};

beforeEach(() => {
  failing.clear();
  appLog.clear();
  // React logs a caught render error; the tests expect those.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

const SCREENS = [
  ["connect", "Connect"],
  ["scan", "Scan"],
  ["live", "Live"],
  ["runs", "Runs"],
  ["settings", "Settings"],
] as const;

describe("a screen's boundary", () => {
  it.each(SCREENS)(
    "contains a failing %s screen: the fallback shows and the rest of the app stays mounted",
    async (id, label) => {
      const user = userEvent.setup();
      failing.add(id);
      renderApp(<App support={SUPPORT} />);
      await user.click(screen.getByRole("tab", { name: label }));

      expect(
        await screen.findByRole("heading", { name: `${label} could not be shown` }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        /rest of the app, your connection and any run in progress are still working/,
      );
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Report this problem" })).toBeVisible();
      if (id === "connect") {
        expect(screen.queryByRole("button", { name: "Go to Connect" })).toBeNull();
      } else {
        expect(screen.getByRole("button", { name: "Go to Connect" })).toBeVisible();
      }
      // The shell, the navigation and the other screens are untouched.
      expect(screen.getByText("obd-read")).toBeVisible();
      expect(screen.getByText("Not connected")).toBeVisible();
      expect(screen.getAllByRole("tab")).toHaveLength(5);
    },
  );

  it("keeps the connection and an open run while a screen fails, and Try again recovers it", async () => {
    const user = userEvent.setup();
    const service = createTestService();
    renderApp(<App support={SUPPORT} />, service);
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await user.click(screen.getByRole("tab", { name: "Live" }));
    await user.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");

    failing.add("scan");
    await user.click(screen.getByRole("tab", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan could not be shown" });
    expect(screen.getByText("Simulator")).toBeVisible();
    expect((await service.client.link.status())?.simulated).toBe(true);
    const runs = await service.client.runs.list({});
    expect(runs.some((run) => run.stoppedAt === null)).toBe(true);

    // Try again fails again while the cause remains, and recovers once it is gone.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Scan could not be shown" });
    failing.delete("scan");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Scan", level: 1 })).toBeVisible();
    expect(screen.queryByText("Scan could not be shown")).toBeNull();

    // The other screens never noticed.
    await user.click(screen.getByRole("tab", { name: "Live" }));
    expect(await screen.findByText("engine speed")).toBeVisible();
  });

  it("Go to Connect leaves the failed screen", async () => {
    const user = userEvent.setup();
    failing.add("runs");
    renderApp(<App support={SUPPORT} />);
    await user.click(screen.getByRole("tab", { name: "Runs" }));
    await user.click(await screen.findByRole("button", { name: "Go to Connect" }));
    expect(await screen.findByRole("heading", { name: "Connect", level: 1 })).toBeVisible();
  });

  it("navigating away and back shows the screen afresh", async () => {
    const user = userEvent.setup();
    failing.add("settings");
    renderApp(<App support={SUPPORT} />);
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings could not be shown" });
    failing.delete("settings");
    await user.click(screen.getByRole("tab", { name: "Connect" }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  });

  it("contains a failing shared viewer, and Go to Connect clears the link", async () => {
    const user = userEvent.setup();
    failing.add("shared");
    window.location.hash = "#share=1.abc";
    renderApp(<App support={SUPPORT} />);
    expect(
      await screen.findByRole("heading", { name: "Shared data could not be shown" }),
    ).toBeVisible();
    expect(screen.getByText("Shared data")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Go to Connect" }));
    expect(await screen.findByRole("heading", { name: "Connect", level: 1 })).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("a different shared link resets the boundary", async () => {
    failing.add("shared");
    window.location.hash = "#share=1.first";
    renderApp(<App support={SUPPORT} />);
    await screen.findByRole("heading", { name: "Shared data could not be shown" });
    failing.delete("shared");
    window.location.hash = "#share=1.second";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Shared viewer" })).toBeVisible();
  });

  it("records the visit and the failure in the event log", async () => {
    const user = userEvent.setup();
    failing.add("live");
    renderApp(<App support={SUPPORT} />);
    await user.click(screen.getByRole("tab", { name: "Live" }));
    await screen.findByRole("heading", { name: "Live could not be shown" });
    const events = appLog.snapshot();
    expect(events).toContainEqual(expect.objectContaining({ kind: "screen", screen: "live" }));
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "error", source: "react", screen: "live" }),
    );
  });
});

describe("the root boundary", () => {
  function Bomb({ explode }: { readonly explode: boolean }) {
    if (explode) throw new Error("root failed");
    return <p>app running</p>;
  }

  function Harness() {
    const [explode, setExplode] = useState(true);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setExplode(false);
          }}
        >
          fix it
        </button>
        <RootBoundary store={store}>
          <Bomb explode={explode} />
        </RootBoundary>
      </>
    );
  }

  const store = new ErrorStore();

  it("shows a full-page fallback with Try again, Reload and Report, and recovers", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "obd-read hit a problem" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload the app" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Report this problem" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "fix it" }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("app running")).toBeVisible();
    expect(store.getState().latest).toMatchObject({
      source: "react",
      screen: "app",
      message: "root failed",
    });
  });
});

describe("ErrorBoundary", () => {
  it("resets when its keys change and not before", () => {
    const store = new ErrorStore();
    let fail = true;
    function Child() {
      if (fail) throw new Error("child failed");
      return <p>child ok</p>;
    }
    const view = render(
      <ErrorBoundary screen="scan" store={store} resetKeys={[1]} fallback={() => <p>fallback</p>}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeVisible();
    fail = false;
    view.rerender(
      <ErrorBoundary screen="scan" store={store} resetKeys={[1]} fallback={() => <p>fallback</p>}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeVisible();
    view.rerender(
      <ErrorBoundary screen="scan" store={store} resetKeys={[2]} fallback={() => <p>fallback</p>}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText("child ok")).toBeVisible();
  });

  it("does not catch what React boundaries cannot: an event handler's error stays with the window handlers", async () => {
    const store = new ErrorStore();
    const user = userEvent.setup();
    const seen: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      seen.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    render(
      <ErrorBoundary screen="scan" store={store} fallback={() => <p>fallback</p>}>
        <button
          type="button"
          onClick={() => {
            throw new Error("handler failed");
          }}
        >
          click me
        </button>
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "click me" }));
    window.removeEventListener("error", onError);
    expect(screen.queryByText("fallback")).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("fallback names the screen and offers each action", () => {
    const store = new ErrorStore();
    render(
      <ScreenFallback
        screen="runs"
        reset={() => undefined}
        onGoToConnect={() => undefined}
        store={store}
      />,
    );
    expect(screen.getByRole("heading", { name: "Runs could not be shown" })).toBeVisible();
  });
});

/** `client` with its `scan.run` call rejecting with `error`. */
function scanFailsWith(client: DiagnosticsClient, error: Error): DiagnosticsClient {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      const isObject = typeof value === "function" || (typeof value === "object" && value !== null);
      if (key !== "scan" || !isObject) return value;
      return new Proxy(value, {
        get: (inner, method): unknown =>
          method === "run" ? () => Promise.reject(error) : Reflect.get(inner, method),
      });
    },
  });
}

describe("expected typed errors stay ordinary UI states", () => {
  it("a refused request shows the screen's own message, not the fallback or a notice", async () => {
    const user = userEvent.setup();
    const store = new ErrorStore();
    const service = createTestService();
    const failing = scanFailsWith(
      service.client,
      new ORPCError("FORBIDDEN", { message: "The guard refused this." }),
    );
    const observed = { ...service, client: observeClient(failing, reportCall(store)) };
    renderApp(
      <>
        <ReportHost store={store} />
        <App support={SUPPORT} />
      </>,
      observed,
    );
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await user.click(screen.getByRole("tab", { name: "Scan" }));
    await user.click(await screen.findByRole("button", { name: "Start scan" }));

    expect(await screen.findByText("The guard refused this.")).toBeVisible();
    expect(screen.queryByText(/could not be shown/)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(store.getState()).toEqual({ latest: undefined, pending: undefined });
    await waitFor(() => {
      expect(appLog.snapshot()).toContainEqual(
        expect.objectContaining({ kind: "operation", name: "scan.run", outcome: "refused" }),
      );
    });
  });

  it("a service call that fails unexpectedly offers a report and leaves the screen in place", async () => {
    const user = userEvent.setup();
    const store = new ErrorStore();
    const service = createTestService();
    const failing = scanFailsWith(service.client, new TypeError("service bug"));
    const observed = { ...service, client: observeClient(failing, reportCall(store)) };
    renderApp(
      <>
        <ReportHost store={store} />
        <App support={SUPPORT} />
      </>,
      observed,
    );
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await user.click(screen.getByRole("tab", { name: "Scan" }));
    await user.click(await screen.findByRole("button", { name: "Start scan" }));

    expect(await screen.findByText("Something went wrong")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Scan", level: 1 })).toBeVisible();
    expect(screen.queryByText(/could not be shown/)).toBeNull();
    expect(store.getState().latest).toMatchObject({ source: "rpc", message: "service bug" });
  });
});
