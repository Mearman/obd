import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sharedScanReport, type ScanShareData } from "obd-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { createTestService, renderApp } from "./render";
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

const SHARED_SCAN: ScanShareData = {
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

async function choose(label: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("the origin of stored data", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("badges each capture with its origin, filters by it and shows it in the viewer", async () => {
    const service = createTestService();
    const capture = await simulatedCapture();
    await service.storage.saveCapture(capture, "shared");
    await service.storage.saveCapture({ ...capture, id: "capture-own" }, "local");
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));

    const listed = await screen.findByRole("table", { name: "Library" });
    await waitFor(() => {
      expect(within(listed).getAllByRole("row")).toHaveLength(3);
    });
    expect(within(listed).getByText("Shared")).toBeInTheDocument();
    expect(within(listed).getByText("Read here")).toBeInTheDocument();

    await choose("Origin", "Shared");
    await waitFor(() => {
      expect(
        within(screen.getByRole("table", { name: "Library" })).getAllByRole("row"),
      ).toHaveLength(2);
    });
    expect(
      within(screen.getByRole("table", { name: "Library" })).queryByText("Read here"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: `View capture ${capture.id}` }));
    const viewer = await screen.findByText(`Capture ${capture.id}`);
    const card = viewer.closest("section") ?? document.body;
    await waitFor(() => {
      expect(within(card).getByText("Shared")).toBeInTheDocument();
    });
  });

  it("lists saved reports in the Library with their origin, filters them, and opens one read-only", async () => {
    const service = createTestService();
    await service.storage.saveScanReport({
      profile: "mercedes-w211",
      adapter: "shared://link",
      takenAt: Date.UTC(2026, 10, 15, 10, 0, 0),
      label: "Shared scan",
      report: sharedScanReport(SHARED_SCAN),
      origin: "shared",
    });
    await service.storage.saveScanReport({
      profile: "mercedes-w211",
      adapter: "simulator://mercedes-w211",
      takenAt: Date.UTC(2026, 10, 15, 9, 0, 0),
      label: "Own scan",
      report: sharedScanReport({ ...SHARED_SCAN, redacted: false }),
    });
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));

    const reports = await screen.findByRole("table", { name: "Library" });
    await waitFor(() => {
      expect(within(reports).getAllByRole("row")).toHaveLength(3);
    });
    expect(within(reports).getByText("Shared")).toBeInTheDocument();
    expect(within(reports).getByText("Read here")).toBeInTheDocument();

    await choose("Origin", "Read here");
    await waitFor(() => {
      expect(
        within(screen.getByRole("table", { name: "Library" })).queryByText("Shared scan"),
      ).not.toBeInTheDocument();
    });
    await choose("Origin", "Shared");
    const shared = await screen.findByRole("table", { name: "Library" });
    await waitFor(() => {
      expect(within(shared).getByText("Shared scan")).toBeInTheDocument();
    });
    await userEvent.click(within(shared).getByRole("button", { name: /^View report / }));
    const opened = await screen.findByLabelText("Saved report");
    expect(
      within(opened).getByText("Shared data from a link, not read from your adapter."),
    ).toBeInTheDocument();
    expect(within(opened).getByRole("table", { name: "Saved fault codes" })).toHaveTextContent(
      "P0420",
    );
    expect(within(opened).queryByRole("button", { name: /clear|write|send/i })).toBeNull();
  });

  it("downloads an opened saved report as the JSON the CLI writes", async () => {
    const service = createTestService();
    const report = sharedScanReport(SHARED_SCAN);
    await service.storage.saveScanReport({
      profile: "mercedes-w211",
      adapter: "simulator://mercedes-w211",
      takenAt: Date.UTC(2026, 10, 15, 9, 0, 0),
      label: "Own scan",
      report,
    });
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:test";
      }),
      revokeObjectURL: vi.fn(),
    });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("button", { name: /^View report / }));
    const opened = await screen.findByLabelText("Saved report");
    await userEvent.click(within(opened).getByRole("button", { name: "Download JSON" }));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.json$/);
    expect(JSON.parse((await blobs[0]?.text()) ?? "")).toEqual(report);
  });

  it("offers Resume only on an open run read here, and filters runs by origin", async () => {
    const service = createTestService();
    await service.storage.createRun({
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: 2000,
      origin: "shared",
    });
    await service.storage.createRun({
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: 1000,
    });
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    const runs = await screen.findByRole("table", { name: "Library" });
    const [, sharedRow, ownRow] = within(runs).getAllByRole("row");
    if (sharedRow === undefined || ownRow === undefined) throw new Error("two runs expected");
    expect(within(sharedRow).getByText("Shared")).toBeInTheDocument();
    expect(within(sharedRow).queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(within(ownRow).getByText("Read here")).toBeInTheDocument();
    expect(within(ownRow).getByRole("button", { name: "Resume" })).toBeInTheDocument();

    await choose("Origin", "Shared");
    await waitFor(() => {
      expect(
        within(screen.getByRole("table", { name: "Library" })).getAllByRole("row"),
      ).toHaveLength(2);
    });
  });
});
