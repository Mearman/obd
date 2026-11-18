import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryStorage, simulatorUrl } from "obd-read";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { LineChart } from "../src/charts";
import { RunSeriesReader } from "../src/screens/run-series";
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

/** Stores a stopped run collected from the simulated car and returns the storage holding it. */
async function collectedRun(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  const service = createTestService(storage);
  const run = await service.client.runs.start({
    profile: "mercedes-w211",
    adapter: simulatorUrl("mercedes-w211"),
  });
  await waitFor(async () => {
    // The fault code lists are text samples taken when a list changes, so they are few.
    const counts = (await service.client.runs.aggregate({ runId: run.id })).filter(
      ({ signal }) => !signal.endsWith("fault codes"),
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.min(...counts.map(({ count }) => count))).toBeGreaterThan(3);
  });
  await service.client.runs.stop({ runId: run.id });
  return storage;
}

async function openGraphs(): Promise<void> {
  await renderApp(<App support={CHROME} />, createTestService(await collectedRun()));
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await userEvent.click(await screen.findByRole("row", { name: /^Open run / }));
  await screen.findByRole("group", { name: "Run playback" });
}

describe("LineChart", () => {
  const points = [
    { t: 0, v: 800 },
    { t: 1000, v: 2000 },
    { t: 2000, v: 1000 },
  ];

  it("is an image with a text summary, and reads out the value at the cursor", async () => {
    await renderApp(
      <LineChart
        name="engine speed"
        unit="rpm"
        points={points}
        cursor={0}
        onCursorChange={vi.fn()}
      />,
    );
    const image = screen.getByRole("img", { name: /engine speed: 3 readings/ });
    expect(image).toHaveAccessibleName(/lowest 800 rpm, highest 2000 rpm/);
    expect(screen.getByText("800 rpm")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "0:00.0, 800 rpm");
  });

  it("moves the cursor by keyboard between readings and to the ends", async () => {
    const onCursorChange = vi.fn();
    await renderApp(
      <LineChart
        name="engine speed"
        unit="rpm"
        points={points}
        cursor={1000}
        onCursorChange={onCursorChange}
      />,
    );
    screen.getByRole("slider").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onCursorChange).toHaveBeenLastCalledWith(2000);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onCursorChange).toHaveBeenLastCalledWith(0);
    await userEvent.keyboard("{End}");
    expect(onCursorChange).toHaveBeenLastCalledWith(2000);
    await userEvent.keyboard("{Home}");
    expect(onCursorChange).toHaveBeenLastCalledWith(0);
  });

  it("is not interactive without a cursor handler, and the compact form has no slider", async () => {
    await renderApp(<LineChart name="engine speed" unit="rpm" points={points} />);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    await renderApp(<LineChart variant="compact" name="boost" unit="kPa" points={points} />);
    expect(screen.getByRole("img", { name: "Trend of boost" })).toBeInTheDocument();
  });
});

describe("RunSeriesReader", () => {
  it("reads on from where it stopped, including readings stored later at the last time read", async () => {
    const storage = new MemoryStorage();
    const { client } = createTestService(storage);
    const run = await storage.createRun({ profile: "p", adapter: "a", startedAt: 1_000 });
    const reading = (timestamp: number, signal: string, value: number) => ({
      runId: run.id,
      signal,
      unit: "",
      timestamp,
      value,
    });
    await storage.appendSamples([reading(1_000, "a", 1), reading(2_000, "a", 2)]);
    const reader = new RunSeriesReader(client, run);
    const first = await reader.read();
    expect(first.series.map(({ signal, points }) => [signal, points])).toEqual([
      [
        "a",
        [
          { t: 0, v: 1 },
          { t: 1_000, v: 2 },
        ],
      ],
    ]);
    expect(first.domain).toEqual([0, 1_000]);

    // A cycle's readings share its time, and the rest of one can be stored after a read.
    await storage.appendSamples([reading(2_000, "b", 20), reading(3_000, "a", 3)]);
    const second = await reader.read();
    expect(second.series.map(({ signal, points }) => [signal, points])).toEqual([
      [
        "a",
        [
          { t: 0, v: 1 },
          { t: 1_000, v: 2 },
          { t: 2_000, v: 3 },
        ],
      ],
      ["b", [{ t: 1_000, v: 20 }]],
    ]);
    expect(second.domain).toEqual([0, 2_000]);
    expect(second.summaries.get("a\u0000")?.readings).toBe(3);
    expect(first.series[0]?.points).toHaveLength(2);
  });
});

describe("Run graphs", () => {
  it("opens a stored simulator run as a chart per signal with a table of values", async () => {
    await openGraphs();
    const charts = screen.getAllByRole("figure");
    expect(charts.length).toBeGreaterThan(1);
    expect(screen.getByRole("img", { name: /^engine speed: \d+ readings/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Values at the cursor" });
    expect(within(table).getAllByRole("row").length).toBe(charts.length + 1);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("reads a stored run once and keeps its graphs while the address moves to the run's sharing link", async () => {
    const reads = vi.spyOn(RunSeriesReader.prototype, "read");
    try {
      await openGraphs();
      const playback = screen.getByRole("group", { name: "Run playback" });
      await waitFor(() => {
        expect(window.location.hash).toMatch(/^#share=/);
      });
      // A stopped run has nothing more to read, so a second read means the graphs started again from loading.
      expect(reads).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("group", { name: "Run playback" })).toBe(playback);
    } finally {
      reads.mockRestore();
    }
  });

  it("moves one cursor across every chart from the keyboard and writes each value", async () => {
    await openGraphs();
    const slider = screen.getByRole("slider", { name: /^Cursor on engine speed/ });
    slider.focus();
    await userEvent.keyboard("{End}");
    const sliders = screen.getAllByRole("slider", { name: /^Cursor on/ });
    const ends = new Set(sliders.map((each) => each.getAttribute("aria-valuenow")));
    expect(ends.size).toBe(1);
    const last = sliders[0]?.getAttribute("aria-valuemax");
    expect(ends.has(last ?? null)).toBe(true);
    for (const each of sliders) {
      expect(each.getAttribute("aria-valuetext")).not.toMatch(/no reading yet|not set/);
    }
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("slider", { name: /^Cursor on engine speed/ })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("plays to the end at a chosen speed", async () => {
    await openGraphs();
    await userEvent.click(screen.getByRole("button", { name: "4x" }));
    expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1x" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    const scrubber = screen.getByRole("slider", { name: "Position in the run" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
    expect(Number(scrubber.getAttribute("max"))).toBeGreaterThan(0);
    expect(scrubber).toHaveValue(scrubber.getAttribute("max"));
  });

  it("plays and pauses with the space bar from a chart, and leaves buttons their own space", async () => {
    await openGraphs();
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    try {
      screen.getAllByRole("slider", { name: /^Cursor on/ })[0]?.focus();
      await userEvent.keyboard(" ");
      expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "true");
      await userEvent.keyboard(" ");
      expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "false");

      screen.getByRole("button", { name: "2x" }).focus();
      await userEvent.keyboard(" ");
      expect(screen.getByRole("button", { name: "2x" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    } finally {
      frame.mockRestore();
    }
  });

  it("scrubs the cursor and shows the values there in the table", async () => {
    await openGraphs();
    const scrubber = screen.getByRole("slider", { name: "Position in the run" });
    fireEvent.change(scrubber, { target: { value: scrubber.getAttribute("max") } });
    const table = screen.getByRole("table", { name: "Values at the cursor" });
    const [, row] = within(table).getAllByRole("row");
    if (row === undefined) throw new Error("no signal row");
    expect(within(row).getAllByRole("cell")[1]).not.toHaveTextContent("-");
  });

  it("follows a run still collecting, keeping a cursor at the end", async () => {
    const service = createTestService();
    const run = await service.client.runs.start({
      profile: "mercedes-w211",
      adapter: simulatorUrl("mercedes-w211"),
    });
    // The worker runs the file's tests one after another, and a run left collecting would charge its work to the tests after this one, so it stops when this test finishes, passed or failed.
    onTestFinished(async () => {
      await service.client.runs.stop({ runId: run.id });
    });
    await waitFor(async () => {
      const counts = await service.client.runs.aggregate({ runId: run.id });
      expect(counts.length).toBeGreaterThan(0);
    });
    await renderApp(<App support={CHROME} />, service);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("row", { name: /^Open run / }));
    const scrubber = await screen.findByRole("slider", { name: "Position in the run" });
    const end = (): number => Number(scrubber.getAttribute("max"));
    const opened = end();
    fireEvent.change(scrubber, { target: { value: String(opened) } });

    await waitFor(() => {
      expect(end()).toBeGreaterThan(opened);
      expect(scrubber).toHaveValue(String(end()));
    });
  });

  it("closes the graphs", async () => {
    await openGraphs();
    await userEvent.click(screen.getByRole("button", { name: "Close graphs" }));
    expect(screen.queryByRole("group", { name: "Run playback" })).not.toBeInTheDocument();
  });
});
