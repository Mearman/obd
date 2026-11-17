import { openSection, pickProfile } from "./ui-helpers";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryStorage,
  jsonSchema,
  decodeShare,
  encodeShare,
  encodeShareBundle,
  fragmentOfLink,
  type ObdReportShareData,
  type ScanShareData,
  type ShareEnvelope,
} from "obd-read";
import { builtinProfileData } from "obd-read/profiles";
import { streamShareCodec } from "obd-read/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { AUTO_SAVED_LIMIT } from "../src/share/auto-saved";
import type { BrowserSupport } from "../src/connect/support";
import { sessionOver, unavailableSession } from "./fake-database";
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
  localStorage.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "share");
});

async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

/** Scans the simulated Volkswagen, whose units answer with a VIN. */
async function scanWithSimulator(): Promise<void> {
  await pickProfile("vag-mqb");
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
  await openSection("Read");
  await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
  await screen.findByRole("table", { name: /Scan of vag-mqb/ });
}

function linkIn(dialog: HTMLElement): string {
  return within(dialog).getByLabelText("Link").textContent;
}

describe("the Share dialog on the Scan screen", () => {
  it("lists what is included, removes the VIN by default and shows the link length", async () => {
    await renderApp(<App support={CHROME} />);
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
    expect(link).toMatch(/^http:\/\/localhost:\d+\/#share=2\./);
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
    await renderApp(<App support={CHROME} />);
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
    await renderApp(<App support={CHROME} />);
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
    await renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openSection("Read");
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

describe("the Share dialog on a run in the Library", () => {
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
    await renderApp(<App support={CHROME} />, createTestService(storage));
    await openTab("Library");
    await userEvent.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this run's summary" });
    const included = await within(dialog).findByRole("list", { name: "What the link contains" });
    expect(included).toHaveTextContent("1 signal with count, minimum, maximum and mean");
    expect(within(dialog).queryByRole("switch")).not.toBeInTheDocument();
    // The link is made after the contents are listed, so wait for it rather than read it at once.
    const link = (await within(dialog).findByLabelText("Link")).textContent;
    const result = await decodeShare(fragmentOfLink(link) ?? "", streamShareCodec);
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

describe("a shared link when the database cannot be used", () => {
  it("says why the link cannot be saved, using the problem the database reports", async () => {
    window.location.hash = await sharedFragment();
    await renderApp(
      <App support={CHROME} />,
      createTestService(),
      unavailableSession("unsupported"),
    );
    await screen.findByRole("table", { name: "Shared scan" });
    expect(
      await screen.findByText(
        "The scan cannot be saved because this browser cannot store data on this device.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save this scan" })).toBeDisabled();
  });
});

describe("a shared link with automatic saving off", () => {
  beforeEach(() => {
    localStorage.setItem("obd-read.auto-save-shared", "off");
  });

  it("opens a read-only viewer labelled as shared data, and writes nothing until Save", async () => {
    window.location.hash = await sharedFragment();
    const storage = new MemoryStorage();
    const service = createTestService(storage);
    await renderApp(<App support={CHROME} />, service, sessionOver(storage));

    expect(await screen.findByRole("heading", { name: "Shared data" })).toBeInTheDocument();
    // The Session screen is the one behind the viewer, and the header still marks the data as shared.
    expect(within(screen.getByRole("banner")).getByText("Shared data")).toBeVisible();
    expect(screen.getByText("From a link, not your adapter")).toBeInTheDocument();
    expect(await screen.findByText(/Dated 15\/11\/2026, 11:00:00 UTC/)).toBeInTheDocument();
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
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("table", { name: "Shared scan" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this scan" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save this scan" }));

    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(window.location.hash).not.toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the shared scan")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const [summary] = await storage.listScanReports({});
    expect(summary).toMatchObject({
      profile: "mercedes-w211",
      adapter: "shared://link",
      label: "Shared scan",
      origin: "shared",
    });
    const saved = await storage.getScanReport(summary?.id ?? "");
    expect(saved?.report).toMatchObject({ tool: "obd-read", origin: "shared", transcript: [] });
  });

  it("writes nothing on Dismiss and clears the address", async () => {
    window.location.hash = await sharedFragment();
    const storage = new MemoryStorage();
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("table", { name: "Shared scan" });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
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
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));

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

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this read" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save this read" }));
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(window.location.hash).not.toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the shared OBD-II read")).toBeInTheDocument();
    const [summary, ...others] = await storage.listScanReports({});
    expect(others).toEqual([]);
    expect(summary).toMatchObject({ label: "Shared OBD-II read", origin: "shared" });
    const saved = await storage.getScanReport(summary?.id ?? "");
    expect(saved?.report).toMatchObject({ format: "obd-report", origin: "shared", obd: data.obd });
  });

  it("says why a link that is not valid cannot be opened", async () => {
    window.location.hash = "share=1.AAAA";
    await renderApp(<App support={CHROME} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/This link cannot be opened/);
    expect(screen.queryByRole("button", { name: "Save this scan" })).not.toBeInTheDocument();
  });

  it("shows a run summary and keeps it only on Save, as a stopped shared run of the readings it carries", async () => {
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
    const storage = new MemoryStorage();
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    const table = await screen.findByRole("table", { name: "Shared run signals" });
    expect(table).toHaveTextContent("engine speed (rpm)");
    expect(within(table).getByRole("img", { name: "Trend of engine speed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save this scan" })).not.toBeInTheDocument();
    expect(await storage.listRuns({})).toEqual([]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this run" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save this run" }));
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(window.location.hash).not.toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the shared run")).toBeInTheDocument();
    const [run, ...others] = await storage.listRuns({});
    expect(others).toEqual([]);
    expect(run).toMatchObject({
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: 1_790_000_000_000,
      stoppedAt: 1_790_000_002_000,
      origin: "shared",
    });
    expect(
      (await storage.readSamples({ runId: run?.id ?? "" })).map((sample) => sample.value),
    ).toEqual([700, 800, 900]);

    // A shared run is listed as shared and offers no Resume, since nothing more can be collected into it.
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    const runs = await screen.findByRole("table", { name: "Library" });
    expect(within(runs).getByText("Shared")).toBeInTheDocument();
    expect(within(runs).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("decodes a shared capture with the profile chosen in the selector, live, and writes nothing", async () => {
    window.location.hash = await captureFragment(await simulatedCapture());
    const storage = new MemoryStorage();
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
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

    await pickProfile("", "Decode with");
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
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("status", { name: "Decoding summary" });
    await pickProfile("w211-engine-only", "Decode with");
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

  it("stores a shared capture only on Save, and opens the stored one from its link afterwards", async () => {
    const capture = await simulatedCapture();
    window.location.hash = await captureFragment(capture);
    const storage = new MemoryStorage();
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByRole("status", { name: "Decoding summary" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this capture" })).toBeEnabled();
    });
    expect(await storage.listCaptures({})).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Save this capture" }));
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(window.location.hash).not.toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the shared capture")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    const [stored, ...others] = await storage.listCaptures({});
    expect(others).toEqual([]);
    expect(stored).toMatchObject({ id: capture.id, origin: "shared" });
    expect((await storage.getCapture(capture.id))?.sessions[0]?.adapter.url).toBeNull();

    window.location.hash = await captureFragment(capture);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    // The capture is stored here now, so its link opens the stored item rather than a second copy.
    expect(await screen.findByRole("status", { name: "Decoding summary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save this capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await storage.listCaptures({})).toHaveLength(1);
  });
});

const AUTO_RUN: ShareEnvelope = {
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
        count: 2,
        numericCount: 2,
        min: 700,
        max: 900,
        mean: 800,
        firstAt: 1_790_000_000_000,
        lastAt: 1_790_000_001_000,
        series: [
          [0, 700],
          [1000, 900],
        ],
      },
    ],
  },
};

async function fragmentOf(envelope: ShareEnvelope): Promise<string> {
  const result = await encodeShare(envelope, streamShareCodec);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.fragment;
}

async function openLink(fragment: string, storage: MemoryStorage): Promise<void> {
  window.location.hash = fragment;
  await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
}

describe("a shared link with the default setting", () => {
  it("saves a scan once, marked shared, and keeps the viewer open with a status", async () => {
    const storage = new MemoryStorage();
    await openLink(await sharedFragment(), storage);
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shared data" })).toBeInTheDocument();
    expect(screen.queryByText(/nothing in it has been saved/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    const [summary, ...others] = await storage.listScanReports({});
    expect(others).toEqual([]);
    expect(summary).toMatchObject({ adapter: "shared://link", origin: "shared" });

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the shared scan")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    expect(await storage.listScanReports({})).toHaveLength(1);
  });

  it("saves an OBD-II read, a run and a capture once each, marked shared", async () => {
    const obd: ShareEnvelope = {
      v: 1,
      kind: "obd-report",
      createdAt: Date.UTC(2026, 10, 15, 11, 0, 0),
      data: {
        taken: "2026-11-15T10:00:00+00:00",
        adapter: { label: "ELM327 v1.5" },
        redacted: true,
        obd: { vin: "", units: [], values: [], monitorResults: [], notes: [] },
      },
    };
    const obdStorage = new MemoryStorage();
    await openLink(await fragmentOf(obd), obdStorage);
    await screen.findByText("Saved to this device, marked as shared.");
    expect(await obdStorage.listScanReports({})).toMatchObject([
      { label: "Shared OBD-II read", origin: "shared" },
    ]);
    cleanup();

    const runStorage = new MemoryStorage();
    await openLink(await fragmentOf(AUTO_RUN), runStorage);
    await screen.findByText("Saved to this device, marked as shared.");
    expect(await runStorage.listRuns({})).toMatchObject([{ origin: "shared" }]);
    cleanup();

    const capture = await simulatedCapture();
    const captureStorage = new MemoryStorage();
    await openLink(await captureFragment(capture), captureStorage);
    await screen.findByText("Saved to this device, marked as shared.");
    expect(await captureStorage.listCaptures({})).toMatchObject([
      { id: capture.id, origin: "shared" },
    ]);
  });

  it("opens the stored run, and saves nothing more, when the same link is opened again", async () => {
    const fragment = await fragmentOf(AUTO_RUN);
    const storage = new MemoryStorage();
    await openLink(fragment, storage);
    await screen.findByText("Saved to this device, marked as shared.");
    cleanup();

    window.location.hash = "";
    await openLink(fragment, storage);
    // The run is stored here now, so its link opens the stored run in the Library, not a second copy.
    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Shared data" })).not.toBeInTheDocument();
    expect(await storage.listRuns({})).toHaveLength(1);
  });

  it("keeps only the newest digests", async () => {
    const storage = new MemoryStorage();
    localStorage.setItem(
      "obd-read.auto-saved-links",
      JSON.stringify(
        Array.from({ length: AUTO_SAVED_LIMIT }, (_, index) => `old-${String(index)}`),
      ),
    );
    await openLink(await fragmentOf(AUTO_RUN), storage);
    await screen.findByText("Saved to this device, marked as shared.");
    const kept: unknown = JSON.parse(localStorage.getItem("obd-read.auto-saved-links") ?? "[]");
    expect(Array.isArray(kept) && kept.length).toBe(AUTO_SAVED_LIMIT);
    expect(Array.isArray(kept) && kept[0]).toBe("old-1");
  });

  it("opens a capture this device already stores as that capture, without saving it again", async () => {
    const capture = await simulatedCapture();
    const storage = new MemoryStorage();
    await storage.saveCapture(capture, "shared");
    await openLink(await captureFragment(capture), storage);
    // A capture this device already stores opens as that capture; nothing is saved again.
    expect(await screen.findByRole("status", { name: "Decoding summary" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await storage.listCaptures({})).toHaveLength(1);
  });

  it("still opens and saves when browser storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const storage = new MemoryStorage();
    await openLink(await fragmentOf(AUTO_RUN), storage);
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(await storage.listRuns({})).toHaveLength(1);
  });
});

describe("the setting Save received links automatically", () => {
  it("is on by default, is stored when turned off, and then a link waits for Save", async () => {
    const view = await renderApp(<App support={CHROME} />);
    await openTab("Settings");
    const toggle = screen.getByRole("switch", { name: "Save received links automatically" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("obd-read.auto-save-shared")).toBe("off");
    view.unmount();

    const storage = new MemoryStorage();
    await openLink(await fragmentOf(AUTO_RUN), storage);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save this run" })).toBeEnabled();
    });
    expect(screen.getByText(/Nothing in it has been saved/)).toBeInTheDocument();
    expect(await storage.listRuns({})).toEqual([]);
  });
});

describe("a shared link of several results", () => {
  /** A run summary of one signal, started at `startedAt`. */
  function runSummary(startedAt: number): ShareEnvelope {
    return {
      v: 1,
      kind: "run-summary",
      createdAt: startedAt,
      data: {
        run: {
          profile: "mercedes-w211",
          adapter: "ble://vLinker",
          startedAt,
          stoppedAt: startedAt + 2000,
          notes: "",
        },
        signals: [
          {
            signal: "engine speed",
            unit: "rpm",
            count: 2,
            numericCount: 2,
            min: 700,
            max: 900,
            mean: 800,
            firstAt: startedAt,
            lastAt: startedAt + 1000,
            series: [
              [0, 700],
              [1000, 900],
            ],
          },
        ],
      },
    };
  }

  async function bundleFragment(): Promise<string> {
    const scan: ShareEnvelope = {
      v: 1,
      kind: "scan",
      createdAt: Date.UTC(2026, 10, 15, 11, 0, 0),
      data: SHARED,
    };
    const result = await encodeShareBundle(
      { createdAt: Date.UTC(2026, 10, 15, 12, 0, 0), items: [scan, runSummary(1_790_000_000_000)] },
      streamShareCodec,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value.fragment;
  }

  it("shows every result together, each under its own heading, and saves them all on Save", async () => {
    localStorage.setItem("obd-read.auto-save-shared", "off");
    window.location.hash = await bundleFragment();
    const storage = new MemoryStorage();
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));

    expect(await screen.findByRole("heading", { name: "Shared data" })).toBeInTheDocument();
    expect(await screen.findByText("2 results")).toBeInTheDocument();
    const first = screen.getByRole("region", { name: "Result 1 of 2: scan" });
    const second = screen.getByRole("region", { name: "Result 2 of 2: run" });
    expect(within(first).getByRole("table", { name: "Shared scan" })).toHaveTextContent(
      "Engine control",
    );
    expect(within(second).getByRole("table", { name: "Shared run signals" })).toHaveTextContent(
      "engine speed (rpm)",
    );
    expect(await storage.listScanReports({})).toEqual([]);
    expect(await storage.listRuns({})).toEqual([]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save all 2 results" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save all 2 results" }));
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Saved the 2 shared results")).toBeInTheDocument();
    expect(await storage.listScanReports({})).toHaveLength(1);
    expect(await storage.listRuns({})).toHaveLength(1);
  });

  it("saves every result once by default, and not again when the link is opened again", async () => {
    const fragment = await bundleFragment();
    const storage = new MemoryStorage();
    window.location.hash = fragment;
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    expect(await screen.findByText("Saved to this device, marked as shared.")).toBeInTheDocument();
    expect(await storage.listScanReports({})).toHaveLength(1);
    expect(await storage.listRuns({})).toHaveLength(1);

    cleanup();
    window.location.hash = fragment;
    await renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    expect(
      await screen.findByText("Already saved to this device earlier, so it was not saved again."),
    ).toBeInTheDocument();
    expect(await storage.listScanReports({})).toHaveLength(1);
    expect(await storage.listRuns({})).toHaveLength(1);
  });
});
