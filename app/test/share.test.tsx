import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryStorage,
  jsonSchema,
  decodeShare,
  encodeShare,
  fragmentOfLink,
  type ObdReportShareData,
  type ScanShareData,
  type ShareEnvelope,
} from "obd-read";
import { builtinProfileData } from "obd-read/profiles";
import { streamShareCodec } from "obd-read/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import type { DatabaseSession } from "../src/database/session";
import { fakeControl } from "./fake-database";
import { createTestService, renderApp } from "./render";
import { captureFragment, simulatedCapture } from "./simulated-capture";

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

const SIMULATED_VIN = "SIMULATEDCAR00001";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

function sessionOver(storage: MemoryStorage): DatabaseSession {
  return {
    connection: Promise.resolve({ storage, control: fakeControl() }),
    close: () => undefined,
  };
}

async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

/** Scans the simulated Volkswagen, whose units answer with a VIN. */
async function scanWithSimulator(): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: "Vehicle profile" }));
  await userEvent.click(await screen.findByRole("option", { name: /vag-mqb/ }));
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
  await openTab("Scan");
  await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("table", { name: /Scan of vag-mqb/ });
}

function linkIn(dialog: HTMLElement): string {
  return within(dialog).getByLabelText("Link").textContent;
}

describe("the Share dialog on the Scan screen", () => {
  it("lists what is included, removes the VIN by default and shows the link length", async () => {
    renderApp(<App support={CHROME} />);
    await scanWithSimulator();
    await userEvent.click(screen.getByRole("button", { name: "Share scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this scan" });

    const included = await within(dialog).findByRole("list", { name: "What the link contains" });
    expect(included).toHaveTextContent(/control units/);
    expect(included).toHaveTextContent(/fault codes with their status bytes/);
    expect(included).toHaveTextContent(/freeze frames/);
    expect(included).toHaveTextContent("VIN and serial numbers: removed.");
    const toggle = within(dialog).getByRole("switch", {
      name: /remove the vin and serial numbers/i,
    });
    expect(toggle).toBeChecked();

    const link = (await within(dialog).findByLabelText("Link")).textContent;
    expect(link).toMatch(/^http:\/\/localhost:\d+\/#share=1\./);
    expect(within(dialog).getByText(`${String(link.length)} characters`)).toBeInTheDocument();
    const redacted = await decodeShare(fragmentOfLink(link) ?? "", streamShareCodec);
    expect(JSON.stringify(redacted)).not.toContain(SIMULATED_VIN);

    await userEvent.click(toggle);
    expect(await within(dialog).findByText(/VIN and serial numbers: included/)).toBeInTheDocument();
    await waitFor(() => {
      expect(linkIn(dialog)).not.toBe(link);
    });
    const open = await decodeShare(fragmentOfLink(linkIn(dialog)) ?? "", streamShareCodec);
    expect(JSON.stringify(open)).toContain(SIMULATED_VIN);
  });

  it("copies the link, and offers the share sheet only where the browser has one", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp(<App support={CHROME} />);
    await scanWithSimulator();
    await userEvent.click(screen.getByRole("button", { name: "Share scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this scan" });
    await within(dialog).findByLabelText("Link");
    expect(within(dialog).queryByRole("button", { name: "Share…" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(linkIn(dialog));
    expect(await within(dialog).findByText("Link copied.")).toBeInTheDocument();
  });

  it("hands the link to the share sheet when there is one", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    renderApp(<App support={CHROME} />);
    await scanWithSimulator();
    await userEvent.click(screen.getByRole("button", { name: "Share scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this scan" });
    await within(dialog).findByLabelText("Link");
    await userEvent.click(within(dialog).getByRole("button", { name: "Share…" }));
    expect(share).toHaveBeenCalledWith({ title: "obd-read result", url: linkIn(dialog) });
  });
});

describe("the Share dialog on a generic OBD-II scan", () => {
  it("makes an OBD-II report link, removing the VIN by default", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openTab("Scan");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    await screen.findByRole("table", { name: /Scan of Generic OBD-II/ });
    await userEvent.click(screen.getByRole("button", { name: "Share scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this scan" });

    const included = await within(dialog).findByRole("list", { name: "What the link contains" });
    expect(included).toHaveTextContent(
      /stored codes?, \d+ pending codes? and \d+ permanent codes?/,
    );
    expect(included).toHaveTextContent("VIN and calibration identifiers: removed.");
    const link = (await within(dialog).findByLabelText("Link")).textContent;
    const redacted = await decodeShare(fragmentOfLink(link) ?? "", streamShareCodec);
    expect(redacted).toMatchObject({ ok: true, value: { kind: "obd-report" } });
    expect(JSON.stringify(redacted)).not.toContain(SIMULATED_VIN);

    await userEvent.click(
      within(dialog).getByRole("switch", { name: /remove the vin and calibration identifiers/i }),
    );
    await waitFor(() => {
      expect(linkIn(dialog)).not.toBe(link);
    });
    const open = await decodeShare(fragmentOfLink(linkIn(dialog)) ?? "", streamShareCodec);
    expect(JSON.stringify(open)).toContain(SIMULATED_VIN);
  });
});

describe("the Share dialog on the Runs screen", () => {
  it("shares a stored run as a summary", async () => {
    const storage = new MemoryStorage();
    const run = await storage.createRun({
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: 1000,
    });
    await storage.appendSamples(
      [0, 1, 2].map((index) => ({
        runId: run.id,
        signal: "engine speed",
        unit: "rpm",
        timestamp: 1000 + index * 100,
        value: 800 + index,
      })),
    );
    await storage.stopRun(run.id, 2000);
    renderApp(<App support={CHROME} />, createTestService(storage));
    await openTab("Runs");
    await userEvent.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this run's summary" });
    const included = await within(dialog).findByRole("list", { name: "What the link contains" });
    expect(included).toHaveTextContent("1 signal with count, minimum, maximum and mean");
    expect(within(dialog).queryByRole("switch")).not.toBeInTheDocument();
    const result = await decodeShare(fragmentOfLink(linkIn(dialog)) ?? "", streamShareCodec);
    expect(
      result.ok && result.value.kind === "run-summary" && result.value.data.signals[0],
    ).toMatchObject({
      signal: "engine speed",
      min: 800,
      max: 802,
    });
  });
});

const SHARED: ScanShareData = {
  taken: "2026-11-15T10:00:00+00:00",
  profile: { name: "mercedes-w211" },
  adapter: { label: "ELM327 v1.5" },
  redacted: true,
  units: [
    {
      unit: "engine",
      description: "Engine control",
      request_id: "7E0",
      response_id: "7E8",
      answered: true,
      notes: [],
      identification: { VIN: { hex: "", text: "" } },
      faults: [{ code: "P0420", status: "2F" }],
      freeze_frames: { P0420: "00 11 22" },
    },
  ],
};

async function sharedFragment(data: ScanShareData = SHARED): Promise<string> {
  const envelope: ShareEnvelope = {
    v: 1,
    kind: "scan",
    createdAt: Date.UTC(2026, 10, 15, 11, 0, 0),
    data,
  };
  const result = await encodeShare(envelope, streamShareCodec);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.fragment;
}

describe("a shared link", () => {
  it("opens a read-only viewer labelled as shared data, and writes nothing until Save", async () => {
    window.location.hash = await sharedFragment();
    const storage = new MemoryStorage();
    const service = createTestService(storage);
    renderApp(<App support={CHROME} />, service, sessionOver(storage));

    expect(await screen.findByRole("heading", { name: "Shared data" })).toBeInTheDocument();
    expect(screen.getByText("From a link, not your adapter")).toBeInTheDocument();
    expect(await screen.findByText(/Link made 15\/11\/2026, 11:00:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/not read from the adapter you have connected/)).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Shared scan" })).toHaveTextContent(
      "Engine control",
    );
    expect(screen.getByRole("table", { name: "Shared fault codes" })).toHaveTextContent("P0420");
    expect(screen.getByRole("table", { name: "Shared fault codes" })).toHaveTextContent("00 11 22");
    expect(screen.getByRole("table", { name: "Shared identification" })).toHaveTextContent(
      "removed",
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear|start scan/i })).not.toBeInTheDocument();

    expect(await storage.listScanReports({})).toEqual([]);
    expect(await storage.listRuns({})).toEqual([]);
    expect(await service.client.link.status()).toBeNull();
  });

  it("stores the scan as a shared report on Save and clears the address", async () => {
    window.location.hash = await sharedFragment();
    const storage = new MemoryStorage();
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("table", { name: "Shared scan" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this scan" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save this scan" }));

    expect(await screen.findByText("Saved the shared scan")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const [summary] = await storage.listScanReports({});
    expect(summary).toMatchObject({
      profile: "mercedes-w211",
      adapter: "shared://link",
      label: "Shared scan",
    });
    const saved = await storage.getScanReport(summary?.id ?? "");
    expect(saved?.report).toMatchObject({ tool: "obd-read", origin: "shared", transcript: [] });
  });

  it("writes nothing on Dismiss and clears the address", async () => {
    window.location.hash = await sharedFragment();
    const storage = new MemoryStorage();
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("table", { name: "Shared scan" });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(await storage.listScanReports({})).toEqual([]);
  });

  it("shows an OBD-II report with the existing result components and no Save", async () => {
    const data: ObdReportShareData = {
      taken: "2026-11-15T10:00:00+00:00",
      adapter: { label: "ELM327 v1.5" },
      redacted: true,
      obd: {
        vin: "",
        units: [
          {
            sender: "7E8",
            lampOn: true,
            codeCount: 1,
            stored: ["P0420"],
            pending: [],
            permanent: null,
            readiness: {
              compressionIgnition: false,
              complete: ["misfire"],
              incomplete: ["catalyst"],
            },
            freezeFrame: { code: "P0420", values: { "engine speed": "800 rpm" } },
            misfire: [],
            calibrationIds: [""],
          },
        ],
        values: [{ sender: "7E8", signal: "engine speed", unit: "rpm", value: 812.5 }],
        monitorResults: [
          {
            sender: "7E8",
            monitor: "monitor 21",
            test: "07",
            scaling: "24",
            value: 5,
            minimum: 0,
            maximum: 3,
            withinLimits: false,
          },
        ],
        notes: [],
      },
    };
    const envelope: ShareEnvelope = {
      v: 1,
      kind: "obd-report",
      createdAt: Date.UTC(2026, 10, 15, 11, 0, 0),
      data,
    };
    const encoded = await encodeShare(envelope, streamShareCodec);
    if (!encoded.ok) throw new Error(encoded.error.message);
    window.location.hash = encoded.value.fragment;
    const storage = new MemoryStorage();
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));

    expect(await screen.findByRole("heading", { name: "Shared data" })).toBeInTheDocument();
    expect(screen.getByText("From a link, not your adapter")).toBeInTheDocument();
    expect(await screen.findByText(/VIN: removed/)).toBeInTheDocument();
    expect(screen.getByText(/Stored codes: P0420/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Live values at the scan" })).toHaveTextContent(
      "812.5",
    );
    expect(screen.getByRole("table", { name: "Monitor test results" })).toHaveTextContent(
      "Outside limits",
    );
    expect(screen.queryByRole("button", { name: "Save this scan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(await storage.listScanReports({})).toEqual([]);
  });

  it("says why a link that is not valid cannot be opened", async () => {
    window.location.hash = "share=1.AAAA";
    renderApp(<App support={CHROME} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/This link cannot be opened/);
    expect(screen.queryByRole("button", { name: "Save this scan" })).not.toBeInTheDocument();
  });

  it("shows a run summary, which cannot be saved as a run", async () => {
    const envelope: ShareEnvelope = {
      v: 1,
      kind: "run-summary",
      createdAt: 1_790_000_000_000,
      data: {
        run: {
          profile: "mercedes-w211",
          adapter: "ble://vLinker",
          startedAt: 1_790_000_000_000,
          stoppedAt: null,
          notes: "",
        },
        signals: [
          {
            signal: "engine speed",
            unit: "rpm",
            count: 3,
            numericCount: 3,
            min: 700,
            max: 900,
            mean: 800,
            firstAt: 1_790_000_000_000,
            lastAt: 1_790_000_002_000,
            series: [
              [0, 700],
              [1000, 800],
              [2000, 900],
            ],
          },
        ],
      },
    };
    const result = await encodeShare(envelope, streamShareCodec);
    if (!result.ok) throw new Error(result.error.message);
    window.location.hash = result.value.fragment;
    renderApp(<App support={CHROME} />);
    const table = await screen.findByRole("table", { name: "Shared run signals" });
    expect(table).toHaveTextContent("engine speed (rpm)");
    expect(within(table).getByRole("img", { name: "Trend of engine speed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save this scan" })).not.toBeInTheDocument();
  });

  it("decodes a shared capture with the profile chosen in the selector, live, and writes nothing", async () => {
    window.location.hash = await captureFragment(await simulatedCapture());
    const storage = new MemoryStorage();
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    const summary = await screen.findByRole("status", { name: "Decoding summary" });
    await waitFor(() => {
      expect(summary).toHaveTextContent(
        /Decoded \d+ Left raw 0 of \d+ exchanges with mercedes-w211/,
      );
    });
    expect(screen.getByRole("table", { name: "Units decoded with mercedes-w211" })).toBeVisible();
    expect(
      within(
        screen.getByRole("table", { name: "Every exchange under mercedes-w211" }),
      ).queryAllByText("Left raw"),
    ).toEqual([]);

    await userEvent.click(screen.getByRole("combobox", { name: "Decode with" }));
    await userEvent.click(screen.getByRole("option", { name: "Generic OBD-II (no profile)" }));
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Decoding summary" })).toHaveTextContent(
        /Left raw [1-9]\d* of \d+ exchanges with Generic OBD-II/,
      );
    });
    const every = screen.getByRole("table", {
      name: "Every exchange under Generic OBD-II (no profile)",
    });
    expect(within(every).getAllByText("Left raw").length).toBeGreaterThan(0);
    expect(within(every).getAllByText("Decoded").length).toBeGreaterThan(0);
    expect(screen.getByRole("table", { name: /leaves raw/ })).toBeVisible();

    expect(await storage.listCaptures({})).toEqual([]);
    expect(await storage.listScanReports({})).toEqual([]);
  });

  it("decodes a shared capture with an imported profile", async () => {
    window.location.hash = await captureFragment(await simulatedCapture());
    const storage = new MemoryStorage();
    const document = builtinProfileData("mercedes-w211");
    const engineOnly: unknown = JSON.parse(JSON.stringify(document));
    if (typeof engineOnly !== "object" || engineOnly === null) throw new Error("no profile");
    Reflect.set(engineOnly, "name", "w211-engine-only");
    const units: unknown = Reflect.get(engineOnly, "units");
    if (typeof units !== "object" || units === null) throw new Error("no units");
    const engine: unknown = Reflect.get(units, "engine");
    Reflect.set(engineOnly, "units", { engine });
    await storage.saveProfile({
      name: "w211-engine-only",
      importedAt: 0,
      document: jsonSchema.parse(engineOnly),
    });
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("status", { name: "Decoding summary" });
    await userEvent.click(screen.getByRole("combobox", { name: "Decode with" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "w211-engine-only (imported)" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Decoding summary" })).toHaveTextContent(
        /Left raw [1-9]\d* of \d+ exchanges with w211-engine-only/,
      );
    });
    expect(
      screen.getByRole("table", { name: "Units decoded with w211-engine-only" }),
    ).toBeVisible();
    expect(await storage.listCaptures({})).toEqual([]);
  });

  it("stores a shared capture only on Save, and refuses one already stored", async () => {
    const capture = await simulatedCapture();
    window.location.hash = await captureFragment(capture);
    const storage = new MemoryStorage();
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("status", { name: "Decoding summary" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this capture" })).toBeEnabled();
    });
    expect(await storage.listCaptures({})).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Save this capture" }));
    expect(await screen.findByText("Saved the shared capture")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    const [stored, ...others] = await storage.listCaptures({});
    expect(others).toEqual([]);
    expect(stored?.id).toBe(capture.id);
    expect((await storage.getCapture(capture.id))?.sessions[0]?.adapter.url).toBeNull();

    window.location.hash = await captureFragment(capture);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Save this capture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already stored on this device/);
    expect(await storage.listCaptures({})).toHaveLength(1);
  });
});
