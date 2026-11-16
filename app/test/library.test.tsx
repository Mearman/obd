import { openSection } from "./ui-helpers";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CAPTURE_FORMAT,
  PLAN_FORMAT,
  sharedScanReport,
  simulatorUrl,
  type ScanShareData,
} from "obd-read";
import { builtinProfileData } from "obd-read/profiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { importRoute } from "../src/library/import-route";
import { createTestService, renderApp, type TestService } from "./render";
import { simulatedCapture } from "./simulated-capture";

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

const SCAN: ScanShareData = {
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
      identification: {},
      faults: [{ code: "P0420", status: "2F" }],
      freeze_frames: {},
    },
  ],
};

/** A run's CSV export: the two fixed columns, then one per signal. */
const RUN_CSV =
  "time,elapsed (s),speed (km/h)\r\n2026-11-15T10:00:01.000Z,1.000,50\r\n2026-11-15T10:00:02.000Z,2.000,60\r\n";

/** An adapter transcript: each line a timestamp, then `>` for a request or `<` for a reply. */
const TRANSCRIPT = [
  "2026-01-02T03:04:05.000+00:00 > ATSP6",
  "2026-01-02T03:04:05.050+00:00 < OK",
  "2026-01-02T03:04:05.100+00:00 > 0100",
  "2026-01-02T03:04:05.150+00:00 < 7E8 06 41 00 08 18 00 00",
].join("\n");

/** The files the page offered to save, by name. */
const saved = new Set<string>();

beforeEach(() => {
  saved.clear();
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.add(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stores one item of each kind, oldest first: a report, a capture, then a shared run. */
async function seeded(): Promise<{
  readonly service: TestService;
  readonly runId: string;
  readonly captureId: string;
  readonly reportId: string;
}> {
  const service = createTestService();
  const report = await service.storage.saveScanReport({
    profile: "mercedes-w211",
    adapter: "simulator://mercedes-w211",
    takenAt: Date.UTC(2026, 10, 14, 9, 0, 0),
    label: "Own scan",
    report: sharedScanReport(SCAN),
  });
  // The simulated capture is taken at 10:00 on 15 November.
  const capture = await simulatedCapture();
  await service.storage.saveCapture(capture, "imported");
  const run = await service.storage.createRun({
    profile: "mercedes-w211",
    adapter: simulatorUrl("mercedes-w211"),
    startedAt: Date.UTC(2026, 10, 16, 8, 0, 0),
    origin: "shared",
  });
  await service.storage.appendSamples([
    {
      runId: run.id,
      signal: "speed",
      unit: "km/h",
      timestamp: Date.UTC(2026, 10, 16, 8, 0, 1),
      value: 50,
    },
  ]);
  await service.storage.stopRun(run.id, Date.UTC(2026, 10, 16, 8, 0, 1));
  return { service, runId: run.id, captureId: capture.id, reportId: report.id };
}

async function openLibrary(service: TestService): Promise<HTMLElement> {
  renderApp(<App support={CHROME} />, service);
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  return screen.findByRole("table", { name: "Library" });
}

/** The library's rows below the header, as each row's kind badge. */
function kindsListed(): string[] {
  const [, ...rows] = within(screen.getByRole("table", { name: "Library" })).getAllByRole("row");
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

async function choose(label: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

async function upload(name: string, text: string): Promise<void> {
  await userEvent.upload(
    screen.getByLabelText("Capture, saved scan, transcript or run file"),
    new File([text], name),
  );
}

describe("routing an imported file by its content", () => {
  it("sends a run's CSV or TSV export to the runs, whatever its header says", () => {
    expect(importRoute(RUN_CSV)).toEqual({ kind: "run" });
    expect(importRoute(RUN_CSV.replaceAll(",", "\t"))).toEqual({ kind: "run" });
    expect(importRoute(`\uFEFF${RUN_CSV}`)).toEqual({ kind: "run" });
    // A wrong header still goes to the run importer, which names the column that differs.
    expect(importRoute("when,elapsed (s)\r\n")).toEqual({ kind: "run" });
  });

  it("sends a capture, a saved scan and a transcript to the captures", async () => {
    expect(importRoute(JSON.stringify(await simulatedCapture()))).toEqual({ kind: "capture" });
    expect(importRoute(JSON.stringify(sharedScanReport(SCAN)))).toEqual({ kind: "capture" });
    expect(importRoute(TRANSCRIPT)).toEqual({ kind: "capture" });
    expect(importRoute(JSON.stringify({ format: CAPTURE_FORMAT }))).toEqual({
      kind: "capture",
    });
    // Text that is neither goes to the transcript importer, which lists what it could not read.
    expect(importRoute("stray line")).toEqual({ kind: "capture" });
    expect(importRoute("{ not json")).toEqual({ kind: "capture" });
  });

  it("refuses a run's JSON export, a recording plan and a vehicle profile, saying where each goes", () => {
    /** Why `text` is refused, or undefined when it is routed somewhere. */
    const refusal = (text: string): string | undefined => {
      const route = importRoute(text);
      return route.kind === "refused" ? route.reason : undefined;
    };
    expect(refusal(JSON.stringify({ format: "obd-read-run", version: 1 }))).toMatch(
      /CSV or TSV export/,
    );
    expect(refusal(JSON.stringify({ format: PLAN_FORMAT }))).toMatch(/Guide screen/);
    expect(refusal(JSON.stringify(builtinProfileData("mercedes-w211")))).toMatch(/Settings/);
  });
});

describe("the Library", () => {
  it("lists every kind in one list, newest first, with the kind, date, profile and origin in each row", async () => {
    const { service } = await seeded();
    await openLibrary(service);
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run", "Capture", "Report"]);
    });
    const [, run, capture, report] = within(
      screen.getByRole("table", { name: "Library" }),
    ).getAllByRole("row");
    if (run === undefined || capture === undefined || report === undefined)
      throw new Error("three rows expected");
    expect(run).toHaveTextContent("16/11/2026, 08:00:00 UTC");
    expect(run).toHaveTextContent("mercedes-w211");
    expect(within(run).getByText("Shared")).toBeInTheDocument();
    expect(within(run).getByText("Simulated")).toBeInTheDocument();
    expect(capture).toHaveTextContent("15/11/2026, 10:00:00 UTC");
    expect(within(capture).getByText("Imported")).toBeInTheDocument();
    expect(report).toHaveTextContent("Own scan");
    expect(within(report).getByText("Read here")).toBeInTheDocument();
  });

  it("filters by kind", async () => {
    const { service } = await seeded();
    await openLibrary(service);
    await waitFor(() => {
      expect(kindsListed()).toHaveLength(3);
    });
    await choose("Kind", "Runs");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run"]);
    });
    await choose("Kind", "Captures");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Capture"]);
    });
    await choose("Kind", "Reports");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Report"]);
    });
    await choose("Kind", "All");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run", "Capture", "Report"]);
    });
  });

  it("filters by origin, together with the kind", async () => {
    const { service } = await seeded();
    await openLibrary(service);
    await choose("Origin", "Imported");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Capture"]);
    });
    await choose("Origin", "Shared");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run"]);
    });
    await choose("Kind", "Reports");
    expect(await screen.findByText("Nothing of this kind and origin.")).toBeVisible();
    await choose("Origin", "Read here");
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Report"]);
    });
  });

  it("imports a run's CSV as an imported run", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("run.csv", RUN_CSV);
    expect(await screen.findByText("Imported run.csv as a stopped run.")).toBeVisible();
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run"]);
    });
    expect(await service.storage.listRuns()).toMatchObject([
      { origin: "imported", adapter: "file run.csv" },
    ]);
  });

  it("names the first column of a run CSV whose header is not the export's", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("bad.csv", "when,elapsed (s)\r\n");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'column 1 of the header is "when" and a run export has "time" there',
    );
    expect(await service.storage.listRuns()).toEqual([]);
    expect(await service.storage.listCaptures()).toEqual([]);
  });

  it("imports a transcript as a capture and opens it in the viewer", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("adapter.log", TRANSCRIPT);
    expect(await screen.findByRole("status", { name: "Decoding summary" })).toBeVisible();
    await waitFor(async () => {
      expect(await service.storage.listCaptures()).toHaveLength(1);
    });
    expect(await service.storage.listRuns()).toEqual([]);
  });

  it("imports a capture document as a capture under its own id", async () => {
    const service = createTestService();
    const capture = await simulatedCapture();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("capture.json", JSON.stringify(capture));
    expect(await screen.findByText(`Capture ${capture.id}`)).toBeVisible();
    expect((await service.storage.listCaptures()).map((stored) => stored.id)).toEqual([capture.id]);
  });

  it("imports a saved scan as a capture", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("scan.json", JSON.stringify(sharedScanReport(SCAN)));
    await waitFor(async () => {
      expect(await service.storage.listCaptures()).toHaveLength(1);
    });
    expect((await service.storage.listCaptures())[0]?.origin).toBe("imported");
  });

  it("imports a file dropped anywhere on the screen, routed the same way", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.drop(screen.getByRole("heading", { level: 1, name: "Library" }), {
      dataTransfer: { files: [new File([RUN_CSV.replaceAll(",", "\t")], "run.tsv")] },
    });
    await waitFor(async () => {
      expect(await service.storage.listRuns()).toHaveLength(1);
    });
  });

  it("refuses a vehicle profile and points to Settings, keeping nothing", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await upload("profile.json", JSON.stringify(builtinProfileData("mercedes-w211")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is a vehicle profile. Import profiles in Settings.",
    );
    expect(await service.storage.listCaptures()).toEqual([]);
    expect(await service.client.profiles.list()).toEqual([]);
  });

  it("opens and closes a run's graphs, shows its fault codes, shares and exports it", async () => {
    const { service, runId } = await seeded();
    const table = await openLibrary(service);
    await userEvent.click(await within(table).findByRole("row", { name: `Open run ${runId}` }));
    expect(await screen.findByRole("group", { name: "Run playback" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "Library" })).toBeNull();
    expect(window.location.search).toBe(`?screen=library&item=run%3A${runId}`);
    await userEvent.click(screen.getByRole("button", { name: "Close graphs" }));
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Run playback" })).toBeNull();
    });
    expect(window.location.search).toBe("?screen=library");

    await userEvent.click(
      (await screen.findByRole("table", { name: "Library" })) &&
        screen.getByRole("button", { name: `Fault codes of run ${runId}` }),
    );
    expect(await screen.findByRole("dialog", { name: "Fault codes" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog", { name: "Share this run's summary" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(saved).toContain(`obd-read-run-${runId}.csv`);
    });
  });

  it("views and deletes a capture", async () => {
    const { service, captureId } = await seeded();
    const table = await openLibrary(service);
    await userEvent.click(
      await within(table).findByRole("row", { name: `Open capture ${captureId}` }),
    );
    expect(await screen.findByText(`Capture ${captureId}`)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Delete capture ${captureId}` }),
    );
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run", "Report"]);
    });
    expect(screen.queryByText(`Capture ${captureId}`)).toBeNull();
    expect(await service.storage.listCaptures()).toEqual([]);
  });

  it("views, downloads and closes a saved report", async () => {
    const { service, reportId } = await seeded();
    const table = await openLibrary(service);
    await userEvent.click(
      await within(table).findByRole("row", { name: `Open report ${reportId}` }),
    );
    const opened = await screen.findByLabelText("Saved report");
    expect(within(opened).getByRole("table", { name: "Saved fault codes" })).toHaveTextContent(
      "P0420",
    );
    await userEvent.click(within(opened).getByRole("button", { name: "Download JSON" }));
    expect(saved).toContain(`${reportId}.json`);
    await userEvent.click(within(opened).getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Saved report")).toBeNull();
  });

  it("returns to the open item with Back after another screen, and opens one from the address", async () => {
    const { service, captureId } = await seeded();
    const table = await openLibrary(service);
    await userEvent.click(
      await within(table).findByRole("row", { name: `Open capture ${captureId}` }),
    );
    expect(await screen.findByText(`Capture ${captureId}`)).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.queryByText(`Capture ${captureId}`)).toBeNull();
    window.history.back();
    await waitFor(() => {
      expect(window.location.search).toBe(`?screen=library&item=capture%3A${captureId}`);
    });
    expect(await screen.findByText(`Capture ${captureId}`)).toBeVisible();
  });

  it("does not open a row from a click on a button inside it", async () => {
    const { service, captureId } = await seeded();
    const table = await openLibrary(service);
    await userEvent.click(
      await within(table).findByRole("button", { name: `Delete capture ${captureId}` }),
    );
    await waitFor(() => {
      expect(kindsListed()).toEqual(["Run", "Report"]);
    });
    expect(window.location.search).toBe("?screen=library");
  });

  it("opens a capture taken on the Session screen in the Library's viewer", async () => {
    const service = createTestService();
    await service.client.link.connect({
      profile: "mercedes-w211",
      adapter: simulatorUrl("mercedes-w211"),
    });
    renderApp(<App support={CHROME} />, service);
    await openSection("Read");
    expect(screen.queryByRole("table", { name: "Saved reports" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Capture everything" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    expect(await screen.findByRole("status", { name: "Decoding summary" })).toBeVisible();
    const [stored] = await service.storage.listCaptures();
    if (stored === undefined) throw new Error("a capture expected");
    expect(await screen.findByText(`Capture ${stored.id}`)).toBeVisible();
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
  });

  it("puts the Library between Session and Guide in the tab bar, with no Runs or Captures tab", () => {
    renderApp(<App support={CHROME} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Library",
      "Guide",
      "Settings",
    ]);
  });
});
