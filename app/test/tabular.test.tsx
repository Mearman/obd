import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sharedScanReport, type ScanShareData } from "obd-read";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: /^View report / }));
    const opened = await screen.findByLabelText("Saved report");

    await userEvent.click(within(opened).getByRole("button", { name: "Download fault codes CSV" }));
    expect(await savedFile(`${row.id}-fault-codes.csv`)).toBe(
      "unit,code,status,description\r\nengine,P0420,2F,\r\n",
    );
    await userEvent.click(within(opened).getByRole("button", { name: "Download fault codes TSV" }));
    expect(await savedFile(`${row.id}-fault-codes.tsv`)).toBe(
      "unit\tcode\tstatus\tdescription\nengine\tP0420\t2F\t\n",
    );
    await userEvent.click(
      within(opened).getByRole("button", { name: "Download identification CSV" }),
    );
    expect(await savedFile(`${row.id}-identification.csv`)).toBe(
      'unit,label,hex,text\r\nengine,Part number,4142,"A,B"\r\n',
    );
    await userEvent.click(
      within(opened).getByRole("button", { name: "Download identification TSV" }),
    );
    expect(await savedFile(`${row.id}-identification.tsv`)).toContain("engine\tPart number");
    // The existing JSON download is still there.
    expect(within(opened).getByRole("button", { name: "Download JSON" })).toBeVisible();
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
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Captures" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `View capture ${summary.id}` }),
    );
    const exchanges = await screen.findByRole("button", { name: "Download raw exchanges CSV" });

    await userEvent.click(exchanges);
    const csv = await savedFile(`${summary.id}-exchanges.csv`);
    expect(csv.split("\r\n")[0]).toBe("time,request id,request,response id,response,outcome");
    expect(csv.split("\r\n").length).toBeGreaterThan(capture.exchanges.length);

    await userEvent.click(screen.getByRole("button", { name: "Download raw exchanges TSV" }));
    expect((await savedFile(`${summary.id}-exchanges.tsv`)).split("\n")[0]).toBe(
      "time\trequest id\trequest\tresponse id\tresponse\toutcome",
    );
    await userEvent.click(screen.getByRole("button", { name: "Download decoded fault codes TSV" }));
    expect(await savedFile(`${summary.id}-fault-codes.tsv`)).toMatch(
      /^unit\tcode\tstatus\tdescription\n/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Download decoded values CSV" }));
    expect((await savedFile(`${summary.id}-values.csv`)).split("\r\n")[0]).toBe(
      "time,unit,name,label,reading,measure,error",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Download decoded identification TSV" }),
    );
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
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(await screen.findByRole("button", { name: "Export CSV" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Export TSV" }));
    await waitFor(() => {
      expect(saved.has(`obd-read-run-${run.id}.tsv`)).toBe(true);
    });
    expect(await savedFile(`obd-read-run-${run.id}.tsv`)).toBe(
      "time\telapsed (s)\tspeed (km/h)\n2026-11-15T10:00:01.000Z\t1.000\t50\n",
    );
  });

  it("imports a picked CSV as an imported run and refuses a file with another header", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    const input = await screen.findByLabelText("Run CSV or TSV file");

    await userEvent.upload(input, new File(["when,elapsed (s)\r\n"], "bad.csv"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'column 1 of the header is "when" and a run export has "time" there',
    );
    expect(await service.storage.listRuns()).toEqual([]);

    await userEvent.upload(input, new File([CSV], "run.csv", { type: "text/csv" }));
    const runs = await screen.findByRole("table", { name: "Collection runs" });
    expect(await within(runs).findByText("Imported")).toBeVisible();
    const [stored] = await service.storage.listRuns();
    expect(stored).toMatchObject({ origin: "imported", adapter: "file run.csv" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("imports a TSV dropped on the import area", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    const area = await screen.findByLabelText("Import a run");
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
