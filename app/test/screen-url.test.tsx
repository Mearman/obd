import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { renderApp } from "./render";

const CHROME: BrowserSupport = {
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

function reset(path: string): void {
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  reset("/");
});
afterEach(() => {
  reset("/");
});

describe("active screen in the address", () => {
  it("opens the screen the query names", () => {
    reset("/?screen=settings");
    renderApp(<App support={CHROME} />);
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to Session for a name that is not a screen", () => {
    reset("/?screen=nowhere");
    renderApp(<App support={CHROME} />);
    expect(screen.getByRole("tab", { name: "Session" })).toHaveAttribute("aria-selected", "true");
  });

  it("writes the screen into the query when the user changes it, and leaves Session out", async () => {
    const user = userEvent.setup();
    renderApp(<App support={CHROME} />);
    expect(window.location.search).toBe("");
    await user.click(screen.getByRole("tab", { name: "Library" }));
    expect(window.location.search).toBe("?screen=library");
    await user.click(screen.getByRole("tab", { name: "Session" }));
    expect(window.location.search).toBe("");
  });

  it("follows Back to the previous screen", async () => {
    const user = userEvent.setup();
    renderApp(<App support={CHROME} />);
    await user.click(screen.getByRole("tab", { name: "Guide" }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    window.history.back();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute("aria-selected", "true");
    });
    expect(window.location.search).toBe("?screen=guide");
  });

  it("keeps the other query parameters", async () => {
    reset("/?keep=1");
    const user = userEvent.setup();
    renderApp(<App support={CHROME} />);
    await user.click(screen.getByRole("tab", { name: "Guide" }));
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("screen")).toBe("guide");
  });
});
