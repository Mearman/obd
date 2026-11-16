import { ORPCError } from "@orpc/client";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type * as ConnectPanelModule from "../src/session/ConnectPanel";
import type * as ReadCardModule from "../src/screens/scan/ReadCard";
import type * as LivePanelModule from "../src/session/LivePanel";
import type * as AdvancedSectionModule from "../src/screens/scan/AdvancedSection";
import type * as GuideScreenModule from "../src/screens/GuideScreen";
import type * as LibraryScreenModule from "../src/library/LibraryScreen";
import type * as SettingsScreenModule from "../src/screens/SettingsScreen";
import type { BrowserSupport } from "../src/connect/support";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import { ErrorStore, observeClient, reportCall } from "../src/report/capture";
import { ErrorBoundary, RootBoundary, ScreenFallback } from "../src/report/ErrorBoundary";
import { appLog } from "../src/report/events";
import { ReportHost } from "../src/report/ReportHost";
import { createTestService, renderApp } from "./render";
import { openSection } from "./ui-helpers";

/** The screens that are made to throw, by name. */
const failing = vi.hoisted(() => new Set<string>());

vi.mock("../src/session/ConnectPanel", async (original) => {
  const real = await original<typeof ConnectPanelModule>();
  return {
    ...real,
    ConnectPanel: (props: Parameters<typeof real.ConnectPanel>[0]) => {
      if (failing.has("connection")) throw new Error("connection failed");
      return real.ConnectPanel(props);
    },
  };
});
vi.mock("../src/screens/scan/ReadCard", async (original) => {
  const real = await original<typeof ReadCardModule>();
  return {
    ReadCard: (props: Parameters<typeof real.ReadCard>[0]) => {
      if (failing.has("read")) throw new Error("read failed");
      return real.ReadCard(props);
    },
  };
});
vi.mock("../src/session/LivePanel", async (original) => {
  const real = await original<typeof LivePanelModule>();
  return {
    LivePanel: () => {
      if (failing.has("live")) throw new Error("live failed");
      return real.LivePanel();
    },
  };
});
vi.mock("../src/screens/scan/AdvancedSection", async (original) => {
  const real = await original<typeof AdvancedSectionModule>();
  return {
    AdvancedSection: (props: Parameters<typeof real.AdvancedSection>[0]) => {
      if (failing.has("advanced")) throw new Error("advanced failed");
      return real.AdvancedSection(props);
    },
  };
});
vi.mock("../src/library/LibraryScreen", async (original) => {
  const real = await original<typeof LibraryScreenModule>();
  return {
    LibraryScreen: (props: Parameters<typeof real.LibraryScreen>[0]) => {
      if (failing.has("library")) throw new Error("library failed");
      return real.LibraryScreen(props);
    },
  };
});
vi.mock("../src/screens/GuideScreen", async (original) => {
  const real = await original<typeof GuideScreenModule>();
  return {
    GuideScreen: (props: Parameters<typeof real.GuideScreen>[0]) => {
      if (failing.has("guide")) throw new Error("guide failed");
      return real.GuideScreen(props);
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
  ["library", "Library"],
  ["guide", "Guide"],
  ["settings", "Settings"],
] as const;

const SECTIONS = [
  ["connection", "Connection"],
  ["read", "Read"],
  ["live", "Live"],
  ["advanced", "Advanced"],
] as const;

/** What every fallback says, and that the shell and its navigation are untouched. */
function expectContained(label: string): void {
  expect(screen.getByRole("heading", { name: `${label} could not be shown` })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    /rest of the app, your connection and any run in progress are still working/,
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Report this problem" })).toBeVisible();
  expect(screen.getByText("obd-read")).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(SCREENS.length + 1);
}

describe("a screen's boundary", () => {
  it.each(SCREENS)(
    "contains a failing %s screen: the fallback shows and the rest of the app stays mounted",
    async (id, label) => {
      const user = userEvent.setup();
      failing.add(id);
      await renderApp(<App support={SUPPORT} />);
      await user.click(screen.getByRole("tab", { name: label }));
      await screen.findByRole("heading", { name: `${label} could not be shown` });
      expectContained(label);
      expect(screen.getByRole("button", { name: "Go to Connect" })).toBeVisible();
      expect(within(screen.getByRole("banner")).getByText("Not connected")).toBeVisible();
    },
  );

  it.each(SECTIONS)(
    "contains a failing %s section: the fallback shows in its place and the other sections work",
    async (id, label) => {
      failing.add(id);
      await renderApp(<App support={SUPPORT} />);
      await openSection(label);
      await screen.findByRole("heading", { name: `${label} could not be shown` });
      expectContained(label);
      if (id === "connection") {
        expect(screen.queryByRole("button", { name: "Go to Connect" })).toBeNull();
      } else {
        expect(screen.getByRole("button", { name: "Go to Connect" })).toBeVisible();
      }
      const others = SECTIONS.filter(([other]) => other !== id);
      for (const [, other] of others) {
        await openSection(other);
        expect(screen.queryByRole("heading", { name: `${other} could not be shown` })).toBeNull();
      }
    },
  );

  it("keeps the connection and an open run while a section fails, and Try again recovers it", async () => {
    const user = userEvent.setup();
    const service = createTestService();
    failing.add("read");
    await renderApp(<App support={SUPPORT} />, service);
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openSection("Live");
    await user.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");

    await openSection("Read");
    await screen.findByRole("heading", { name: "Read could not be shown" });
    expect((await service.client.link.status())?.simulated).toBe(true);
    const runs = await service.client.runs.list({});
    expect(runs.some((run) => run.stoppedAt === null)).toBe(true);

    // Try again fails again while the cause remains, and recovers once it is gone.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Read could not be shown" });
    failing.delete("read");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Start scan" })).toBeVisible();
    expect(screen.queryByText("Read could not be shown")).toBeNull();

    // The other sections never noticed.
    await openSection("Live");
    expect(await screen.findByText("engine speed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("Go to Connect leaves the failed screen for the Session's Connection section", async () => {
    const user = userEvent.setup();
    failing.add("library");
    await renderApp(<App support={SUPPORT} />);
    await openSection("Read");
    await user.click(screen.getByRole("tab", { name: "Library" }));
    await user.click(await screen.findByRole("button", { name: "Go to Connect" }));
    expect(await screen.findByRole("heading", { name: "Session", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: /connect with the simulator/i })).toBeVisible();
  });

  it("navigating away and back shows the screen afresh", async () => {
    const user = userEvent.setup();
    failing.add("settings");
    await renderApp(<App support={SUPPORT} />);
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings could not be shown" });
    failing.delete("settings");
    await user.click(screen.getByRole("tab", { name: "Session" }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  });

  it("contains a failing shared viewer, and Go to Connect clears the link", async () => {
    const user = userEvent.setup();
    failing.add("shared");
    window.location.hash = "#share=1.abc";
    await renderApp(<App support={SUPPORT} />);
    expect(
      await screen.findByRole("heading", { name: "Shared data could not be shown" }),
    ).toBeVisible();
    expect(screen.getByText("Shared data")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Go to Connect" }));
    expect(await screen.findByRole("heading", { name: "Session", level: 1 })).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("a different shared link resets the boundary", async () => {
    failing.add("shared");
    window.location.hash = "#share=1.first";
    await renderApp(<App support={SUPPORT} />);
    await screen.findByRole("heading", { name: "Shared data could not be shown" });
    failing.delete("shared");
    window.location.hash = "#share=1.second";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Shared viewer" })).toBeVisible();
  });

  it("records the visit and a section's failure in the event log", async () => {
    failing.add("live");
    await renderApp(<App support={SUPPORT} />);
    await openSection("Live");
    await screen.findByRole("heading", { name: "Live could not be shown" });
    const events = appLog.snapshot();
    expect(events).toContainEqual(expect.objectContaining({ kind: "screen", screen: "session" }));
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
      <ErrorBoundary screen="read" store={store} resetKeys={[1]} fallback={() => <p>fallback</p>}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeVisible();
    fail = false;
    view.rerender(
      <ErrorBoundary screen="read" store={store} resetKeys={[1]} fallback={() => <p>fallback</p>}>
        <Child />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeVisible();
    view.rerender(
      <ErrorBoundary screen="read" store={store} resetKeys={[2]} fallback={() => <p>fallback</p>}>
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
      <ErrorBoundary screen="read" store={store} fallback={() => <p>fallback</p>}>
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
        screen="library"
        reset={() => undefined}
        onGoToConnect={() => undefined}
        store={store}
      />,
    );
    expect(screen.getByRole("heading", { name: "Library could not be shown" })).toBeVisible();
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
    await renderApp(
      <>
        <ReportHost store={store} />
        <App support={SUPPORT} />
      </>,
      observed,
    );
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openSection("Read");
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
    await renderApp(
      <>
        <ReportHost store={store} />
        <App support={SUPPORT} />
      </>,
      observed,
    );
    await user.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openSection("Read");
    await user.click(await screen.findByRole("button", { name: "Start scan" }));

    expect(await screen.findByText("Something went wrong")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start scan" })).toBeVisible();
    expect(screen.queryByText(/could not be shown/)).toBeNull();
    expect(store.getState().latest).toMatchObject({ source: "rpc", message: "service bug" });
  });
});
