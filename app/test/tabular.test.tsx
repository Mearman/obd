import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GENERIC_PROFILE,
  sharedObdReportDocument,
  sharedScanReport,
  type ObdScan,
  type ScanShareData,
} from "obd-read";
import { builtinProfileData } from "obd-read/profiles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { sessionOver } from "./fake-database";
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
      identification: { "Part number": { hex: "4142", text: "A,B" } },
      faults: [{ code: "P0420", status: "2F" }],
      freeze_frames: {},
    },
  ],
};

/** A generic OBD-II read with one stored and one pending code. */
const OBD_READ: ObdScan = {
  vin: "",
  units: [
    {
      sender: "7E8",
      lampOn: true,
      codeCount: 1,
      stored: ["P0420"],
      pending: ["P0171"],
      permanent: null,
      readiness: { compressionIgnition: false, complete: [], incomplete: [] },
      freezeFrame: null,
      misfire: [],
      calibrationIds: [],
    },
  ],
  values: [],
  monitorResults: [],
  notes: [],
};

/** The files the page offered to save, by name, with their text. */
const saved = new Map<string, Promise<string>>();

beforeEach(() => {
  saved.clear();
  const blobs: Blob[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:${String(blobs.length - 1)}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs[Number(this.href.replace("blob:", ""))];
    if (blob !== undefined) saved.set(this.download, blob.text());
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function savedFile(name: string): Promise<string> {
  const text = saved.get(name);
  if (text === undefined) throw new Error(`nothing was saved as ${name}`);
  return text;
}

describe("downloads of a saved report", () => {
  it("offers its fault codes and identification values as CSV and TSV", async () => {
    const service = createTestService();
    const row = await service.storage.saveScanReport({
      profile: "mercedes-w211",
      adapter: "simulator://mercedes-w211",
      takenAt: Date.UTC(2026, 10, 15, 9, 0, 0),
      label: "Own scan",
      report: sharedScanReport(SCAN),
    });
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("row", { name: /^Open report / }));
    const opened = await screen.findByLabelText("Saved report");

    await chooseDownload(within(opened), "fault codes CSV");
    expect(await savedFile(`${row.id}-fault-codes.csv`)).toBe(
      "unit,code,status,description\r\nengine,P0420,2F,\r\n",
    );
    await chooseDownload(within(opened), "fault codes TSV");
    expect(await savedFile(`${row.id}-fault-codes.tsv`)).toBe(
      "unit\tcode\tstatus\tdescription\nengine\tP0420\t2F\t\n",
    );
    await chooseDownload(within(opened), "identification CSV");
    expect(await savedFile(`${row.id}-identification.csv`)).toBe(
      'unit,label,hex,text\r\nengine,Part number,4142,"A,B"\r\n',
    );
    await chooseDownload(within(opened), "identification TSV");
    expect(await savedFile(`${row.id}-identification.tsv`)).toContain("engine\tPart number");
    // The existing JSON download is still there.
    expect(within(opened).getByRole("button", { name: "Download JSON" })).toBeVisible();
  });

  it("describes a generic OBD-II read's codes with the generic titles, as the command line does", async () => {
    const service = createTestService();
    const row = await service.storage.saveScanReport({
      profile: GENERIC_PROFILE,
      adapter: "simulator://generic",
      takenAt: Date.UTC(2026, 10, 15, 9, 0, 0),
      label: "",
      report: sharedObdReportDocument({
        taken: "2026-11-15T09:00:00+00:00",
        adapter: { label: "ELM327 v1.5" },
        redacted: true,
        obd: OBD_READ,
      }),
    });
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("row", { name: /^Open report / }));
    const opened = await screen.findByLabelText("Saved report");

    await chooseDownload(within(opened), "fault codes CSV");
    expect(await savedFile(`${row.id}-fault-codes.csv`)).toBe(
      [
        "unit,code,status,description",
        "7E8,P0420,stored,Catalyst System Efficiency Below Threshold Bank 1",
        "7E8,P0171,pending,System Too Lean Bank 1",
        "",
      ].join("\r\n"),
    );
  });

  it("describes a scan's codes with the names its imported profile gives them", async () => {
    const service = createTestService();
    const shipped = builtinProfileData("mercedes-w211");
    if (typeof shipped !== "object" || shipped === null) throw new Error("no shipped W211 profile");
    const named = {
      ...shipped,
      name: "w211-with-names",
      codes: { engine: { P0420: { text: "Catalyst below threshold", source: "workshop notes" } } },
    };
    await service.client.profiles.import({ json: JSON.stringify(named) });
    const row = await service.storage.saveScanReport({
      profile: "w211-with-names",
      adapter: "simulator://mercedes-w211",
      takenAt: Date.UTC(2026, 10, 15, 9, 0, 0),
      label: "Named scan",
      report: sharedScanReport({ ...SCAN, profile: { name: "w211-with-names" } }),
    });
    await renderApp(<App support={CHROME} />, service, sessionOver(service.storage));
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("row", { name: /^Open report / }));
    const opened = await screen.findByLabelText("Saved report");

    await chooseDownload(within(opened), "fault codes CSV");
    expect(await savedFile(`${row.id}-fault-codes.csv`)).toBe(
      "unit,code,status,description\r\nengine,P0420,2F,Catalyst below threshold\r\n",
    );
  });
});

describe("downloads of a decoded capture", () => {
  it("offers the decoded values, fault codes, identification and raw exchanges", async () => {
    const service = createTestService();
    const capture = await simulatedCapture();
    const { summary } = await service.client.captures.import({
      text: JSON.stringify(capture),
      name: "capture.obdcap.json",
    });
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("row", { name: `Open capture ${summary.id}` }));
    await chooseDownload(screen, "raw exchanges CSV");
    const csv = await savedFile(`${summary.id}-exchanges.csv`);
    expect(csv.split("\r\n")[0]).toBe("time,request id,request,response id,response,outcome");
    expect(csv.split("\r\n").length).toBeGreaterThan(capture.exchanges.length);

    await chooseDownload(screen, "raw exchanges TSV");
    expect((await savedFile(`${summary.id}-exchanges.tsv`)).split("\n")[0]).toBe(
      "time\trequest id\trequest\tresponse id\tresponse\toutcome",
    );
    await chooseDownload(screen, "decoded fault codes TSV");
    expect(await savedFile(`${summary.id}-fault-codes.tsv`)).toMatch(
      /^unit\tcode\tstatus\tdescription\n/,
    );
    await chooseDownload(screen, "decoded values CSV");
    expect((await savedFile(`${summary.id}-values.csv`)).split("\r\n")[0]).toBe(
      "time,unit,name,label,reading,measure,error",
    );
    await chooseDownload(screen, "decoded identification TSV");
    expect(await savedFile(`${summary.id}-identification.tsv`)).toMatch(
      /^unit\tlabel\thex\ttext\n/,
    );
  });
});

describe("runs as CSV and TSV", () => {
  const CSV =
    "time,elapsed (s),speed (km/h),gear\r\n2026-11-15T10:00:01.000Z,1.000,50,D\r\n2026-11-15T10:00:02.000Z,2.000,60,\r\n";

  it("exports TSV beside CSV and JSON", async () => {
    const service = createTestService();
    const run = await service.storage.createRun({
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: Date.UTC(2026, 10, 15, 10, 0, 0),
    });
    await service.storage.appendSamples([
      {
        runId: run.id,
        signal: "speed",
        unit: "km/h",
        timestamp: Date.UTC(2026, 10, 15, 10, 0, 1),
        value: 50,
      },
    ]);
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("button", { name: `Export run ${run.id}` }));
    expect(await screen.findByRole("menuitem", { name: "CSV" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "JSON" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "TSV" }));
    await waitFor(() => {
      expect(saved.has(`obd-read-run-${run.id}.tsv`)).toBe(true);
    });
    expect(await savedFile(`obd-read-run-${run.id}.tsv`)).toBe(
      "time\telapsed (s)\tspeed (km/h)\n2026-11-15T10:00:01.000Z\t1.000\t50\n",
    );
  });

  it("imports a picked CSV as an imported run and refuses a file with another header", async () => {
    const service = createTestService();
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    const input = await screen.findByLabelText("Capture, saved scan, transcript or run file");

    await userEvent.upload(input, new File(["when,elapsed (s)\r\n"], "bad.csv"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'column 1 of the header is "when" and a run export has "time" there',
    );
    expect(await service.storage.listRuns()).toEqual([]);

    await userEvent.upload(input, new File([CSV], "run.csv", { type: "text/csv" }));
    const runs = await screen.findByRole("table", { name: "Library" });
    expect(await within(runs).findByText("Imported")).toBeVisible();
    const [stored] = await service.storage.listRuns();
    expect(stored).toMatchObject({ origin: "imported", adapter: "file run.csv" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("imports a TSV dropped on the import area", async () => {
    const service = createTestService();
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    const area = await screen.findByRole("heading", { level: 1, name: "Library" });
    const file = new File([CSV.replaceAll(",", "\t").replaceAll("\r\n", "\n")], "run.tsv");
    fireEvent.drop(area, { dataTransfer: { files: [file] } });
    await waitFor(async () => {
      expect(await service.storage.listRuns()).toHaveLength(1);
    });
    const samples = await service.storage.readSamples({
      runId: (await service.storage.listRuns())[0]?.id ?? "",
    });
    expect(samples.map((sample) => [sample.signal, sample.value])).toEqual([
      ["speed", 50],
      ["gear", "D"],
      ["speed", 60],
    ]);
  });
});

/** Saves one table from a view's Download menu: opens the menu inside `scope`, then picks the item. */
async function chooseDownload(
  scope: Pick<typeof screen, "findByRole">,
  item: string,
): Promise<void> {
  await userEvent.click(await scope.findByRole("button", { name: "Download" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}
