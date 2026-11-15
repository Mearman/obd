import { pickProfile } from "./ui-helpers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { builtinProfileData } from "obd-read/profiles";
import { GENERIC_SIMULATOR_URL, MemoryStorage, simulatorUrl } from "obd-read";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { failureMessage } from "../src/diagnostics/client";
import { applyThemePreference } from "../src/theme/preference";
import { createTestService, renderApp } from "./render";

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

  it("opens the Bluetooth picker on the page first, and reports a connection that fails", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("button", { name: /connect with bluetooth le/i }));
    expect(service.devices.prepare).toHaveBeenCalledWith("webbluetooth://vLinker");
    expect(await screen.findByRole("alert")).toHaveTextContent(/no transport host serves/);
  });

  it("lists every nearby device when asked to", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(
      screen.getByRole("switch", { name: /list every nearby bluetooth device/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /connect with bluetooth le/i }));
    expect(service.devices.prepare).toHaveBeenCalledWith("webbluetooth://adapter?all=1");
  });

  it("hands a chosen serial port to the service before connecting", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("button", { name: /connect with usb or serial/i }));
    expect(service.devices.chooseSerial).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no transport host serves/);
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

/** Picks a vehicle profile on the Connect screen; the default is generic OBD-II. */
async function chooseProfile(name: string): Promise<void> {
  await pickProfile(name);
}

async function connectSimulator(profile?: string): Promise<void> {
  if (profile !== undefined) await chooseProfile(profile);
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
}

async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

describe("Scan", () => {
  it("scans with the simulator once connected", async () => {
    renderApp(<App support={CHROME} />);
    await openTab("Scan");
    expect(screen.getByRole("button", { name: "Start scan" })).toBeDisabled();
    await openTab("Connect");
    await connectSimulator("mercedes-w211");
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("table", { name: /Scan of mercedes-w211/ })).toBeInTheDocument();
    expect((await screen.findAllByText("Faults stored")).length).toBeGreaterThan(0);
  });

  it("clears a unit's codes only after the second step", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await connectSimulator("mercedes-w211");
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear engine codes" }));

    const dialog = await screen.findByRole("dialog", { name: /Clear fault codes from/ });
    expect(dialog).toHaveTextContent("Nothing has been sent to the car yet");
    expect(dialog).toHaveTextContent(/snapshot saved/);
    const labels = (await service.client.reports.list({})).map((report) => report.label);
    expect(labels.filter((label) => label.startsWith("clear-engine"))).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Send to the car" }));
    expect(await within(dialog).findByText("Done.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect((await service.client.units.faults({ unit: "engine" })).faults).toEqual([]);
  });

  it("sends nothing when the request is cancelled, and frees the adapter", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await connectSimulator("mercedes-w211");
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear engine codes" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect((await service.client.units.faults({ unit: "engine" })).faults).toHaveLength(1);
  });

  it("shows the guard's refusal of a request that is not a write", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator("mercedes-w211");
    await openTab("Scan");
    await userEvent.type(screen.getByLabelText("Write request (hexadecimal)"), "10 03");
    await userEvent.type(screen.getByLabelText("Read request for the same value"), "21 99");
    await userEvent.click(screen.getByRole("button", { name: "Write a value" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a kwp2000 write request/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Live values and Runs", () => {
  it("collects readings, holds a wake lock while it runs and lists the run", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(() => Promise.resolve({ release, released: false }));
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    try {
      renderApp(<App support={CHROME} />);
      await openTab("Live");
      expect(screen.getByRole("button", { name: "Start collecting" })).toBeDisabled();
      await openTab("Connect");
      await connectSimulator();
      await openTab("Live");
      expect(
        screen.getByText(/No web API guarantees collection in the background/),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Start collecting" }));
      expect(await screen.findByText("engine speed")).toBeInTheDocument();
      expect(request).toHaveBeenCalledWith("screen");

      await openTab("Runs");
      const table = await screen.findByRole("table", { name: "Collection runs" });
      expect(within(table).getByText("Collecting")).toBeInTheDocument();
      expect(within(table).getByText("Simulated")).toBeInTheDocument();

      await openTab("Live");
      await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
      await waitFor(() => {
        expect(release).toHaveBeenCalled();
      });
      await openTab("Runs");
      expect(await screen.findByText("Stopped")).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("resumes a simulator run left open by an earlier page", async () => {
    const storage = new MemoryStorage();
    const earlier = createTestService(storage);
    const run = await earlier.client.runs.start({
      profile: "mercedes-w211",
      adapter: simulatorUrl("mercedes-w211"),
    });
    // The earlier page and its collector are gone; the stored run is not.
    const later = createTestService(storage);
    renderApp(<App support={CHROME} />, later);
    await openTab("Live");
    expect(await screen.findByText("engine speed")).toBeInTheDocument();
    expect(await later.client.runs.status({ runId: run.id })).toMatchObject({
      state: "collecting",
    });
    await later.client.runs.stop({ runId: run.id });
  });

  it("lists an open run from hardware with a Resume button", async () => {
    const storage = new MemoryStorage();
    await storage.createRun({
      profile: "mercedes-w211",
      adapter: "webbluetooth://vLinker",
      startedAt: 1_700_000_000_000,
    });
    renderApp(<App support={CHROME} />, createTestService(storage));
    await openTab("Runs");
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("says when there are no runs", async () => {
    renderApp(<App support={CHROME} />);
    await openTab("Runs");
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
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

describe("Generic OBD-II (no profile)", () => {
  it("is the first option and the default, with a line saying what it can and cannot do", async () => {
    renderApp(<App support={CHROME} />);
    const select = screen.getByRole("button", { name: /Vehicle profile/ });
    expect(select).toHaveTextContent("Generic OBD-II (no profile)");
    expect(screen.getByText(/It cannot address one control unit/)).toBeInTheDocument();
    await userEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Generic OBD-II (no profile)");
    expect(options.length).toBeGreaterThan(1);
    const w211 = options.find((option) => option.dataset.profile === "mercedes-w211");
    if (w211 === undefined) throw new Error("no w211 option");
    await userEvent.click(w211);
    expect(screen.queryByText(/It cannot address one control unit/)).not.toBeInTheDocument();
  });

  it("narrows the list as the user types and says when nothing matches", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("button", { name: /Vehicle profile/ }));
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search vehicle profiles" }),
      "w211",
    );
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("data-profile", "mercedes-w211");
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "zzzz");
    expect(screen.getByText(/No profile matches/)).toBeInTheDocument();
  });

  it("connects the simulator without a profile and names the connection as generic", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await connectSimulator();
    expect(screen.getByText(/Profile: Generic OBD-II \(no profile\)/)).toBeInTheDocument();
    expect(await service.client.link.status()).toMatchObject({ profile: null, simulated: true });
  });

  it("scans the legislated services and shows the OBD report in the existing table", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    const table = await screen.findByRole("table", { name: /Scan of Generic OBD-II/ });
    expect(within(table).getByText("Emissions control unit 7E8")).toBeInTheDocument();
    expect(within(table).getByText("Faults stored")).toBeInTheDocument();
    expect(await screen.findByText(/VIN: SIMULATEDCAR00001/)).toBeInTheDocument();
    expect(screen.getByText(/Stored codes: P0420/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Live values at the scan" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Monitor test results" })).toBeInTheDocument();
  });

  it("disables every unit-level action with the reason, and leaves the emissions clear enabled", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    await screen.findByRole("table", { name: /Scan of Generic OBD-II/ });

    const reason = /needs a vehicle profile/;
    for (const name of ["Write a value", "Run an actuator test", "Clear 7E8 codes"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
    expect(screen.getByLabelText("Unit to change")).toBeDisabled();
    expect(screen.getByLabelText("Write request (hexadecimal)")).toBeDisabled();
    expect(screen.getByLabelText("Actuator start request (hexadecimal)")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
    ).toBeEnabled();
  });

  it("clears every emissions code only after the second step", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await connectSimulator();
    await openTab("Scan");
    await userEvent.click(
      screen.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Clear emissions codes/ });
    expect(dialog).toHaveTextContent("Nothing has been sent to the car yet");
    expect(dialog).toHaveTextContent(/stored codes from 7E8: P0420/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send to the car" }));
    expect(await within(dialog).findByText("Done.")).toBeInTheDocument();
    expect((await service.client.scan.run({})).obd?.units[0]?.stored).toEqual([]);
  });

  it("collects the legislated values in a run listed under the generic name", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    await openTab("Live");
    expect(screen.getByText(/This connection has no profile/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start collecting" }));
    expect(await screen.findByText("engine speed")).toBeInTheDocument();
    await openTab("Runs");
    const table = await screen.findByRole("table", { name: "Collection runs" });
    expect(within(table).getByText("Generic OBD-II (no profile)")).toBeInTheDocument();
    await openTab("Live");
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("renders a profile-only refusal as one line, never a crash", async () => {
    const service = createTestService();
    await service.client.link.connect({ adapter: GENERIC_SIMULATOR_URL });
    const refusal = await service.client.units
      .faults({ unit: "engine" })
      .catch((error: unknown) => error);
    const message = failureMessage(refusal, "The request failed.");
    expect(message).toMatch(/^reading one unit needs a vehicle profile/);
    expect(message).not.toContain("\n");
  });
});
