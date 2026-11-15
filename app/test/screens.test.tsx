import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { builtinProfileData } from "obd-read/profiles";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { applyThemePreference } from "../src/theme/preference";
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

const SAFARI_IPHONE: BrowserSupport = {
  family: "ios",
  capabilities: {
    webSerial: false,
    webBluetooth: false,
    webUsb: false,
    secureContext: true,
    usable: false,
    issues: ["Web Serial is not available: it needs Chrome or Edge."],
  },
};

describe("Connect screen", () => {
  it("disables hardware adapters with the reason on an iPhone, and still offers the simulator", () => {
    renderApp(<App support={SAFARI_IPHONE} />);
    const bluetooth = screen.getByRole("button", { name: /connect with bluetooth le/i });
    expect(bluetooth).toBeDisabled();
    expect(bluetooth).toHaveAccessibleDescription(/every iOS browser uses Safari/);
    expect(screen.getByRole("button", { name: /connect with the simulator/i })).toBeEnabled();
  });

  it("reports that a real adapter cannot be reached in this build", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("button", { name: /connect with bluetooth le/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot reach a real adapter/);
  });

  it("connects the simulator and labels the data as simulated", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    expect(await screen.findByText("Connected to Simulator")).toBeInTheDocument();
    expect(screen.getAllByText("Simulated data").length).toBeGreaterThan(0);
  });

  it("opens the browser support dialog", async () => {
    renderApp(<App support={SAFARI_IPHONE} />);
    await userEvent.click(screen.getByRole("button", { name: "Which browsers work?" }));
    expect(await screen.findByRole("dialog", { name: "Browser support" })).toBeInTheDocument();
  });
});

describe("Scan, Live and Runs", () => {
  it("scans with the simulator once connected, then shows live values", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Scan" }));
    expect(screen.getByRole("button", { name: "Start scan" })).toBeDisabled();

    await userEvent.click(screen.getByRole("tab", { name: "Connect" }));
    await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");

    await userEvent.click(screen.getByRole("tab", { name: "Scan" }));
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("table", { name: /Scan of/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Live" }));
    expect(await screen.findByText("Engine speed")).toBeInTheDocument();
  });

  it("lists the simulated runs", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(await screen.findByRole("table", { name: "Collection runs" })).toBeInTheDocument();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
  });
});

describe("Settings screen", () => {
  it("imports a valid profile file and rejects an invalid one with its problems", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    const input = screen.getByLabelText("Profile file");

    const bundled = builtinProfileData("vag-mqb");
    if (typeof bundled !== "object" || bundled === null)
      throw new Error("profile is not an object");
    const renamed = JSON.stringify({ ...bundled, name: "imported-copy" });
    await userEvent.upload(input, new File([renamed], "copy.json", { type: "application/json" }));
    expect(await screen.findByText("Imported profile imported-copy.")).toBeInTheDocument();

    await userEvent.upload(input, new File(["{}"], "bad.json", { type: "application/json" }));
    expect(await screen.findByText("That file is not a valid profile:")).toBeInTheDocument();
  });

  it("applies the chosen colour scheme to the document", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Colour scheme" }));
    await userEvent.click(await screen.findByRole("option", { name: "Dark" }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
    applyThemePreference("system", document.documentElement);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
