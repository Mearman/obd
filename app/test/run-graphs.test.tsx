import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryStorage, simulatorUrl } from "obd-read";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { LineChart } from "../src/charts";
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
  await waitFor(
    async () => {
      const counts = await service.client.runs.aggregate({ runId: run.id });
      expect(counts.length).toBeGreaterThan(0);
      expect(Math.min(...counts.map(({ count }) => count))).toBeGreaterThan(3);
    },
    { timeout: 10_000 },
  );
  await service.client.runs.stop({ runId: run.id });
  return storage;
}

async function openGraphs(): Promise<void> {
  renderApp(<App support={CHROME} />, createTestService(await collectedRun()));
  await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
  await userEvent.click(await screen.findByRole("button", { name: "View graphs" }));
  await screen.findByRole("group", { name: "Run playback" });
}

describe("LineChart", () => {
  const points = [
    { t: 0, v: 800 },
    { t: 1000, v: 2000 },
    { t: 2000, v: 1000 },
  ];

  it("is an image with a text summary, and reads out the value at the cursor", () => {
    renderApp(
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
    renderApp(
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

  it("is not interactive without a cursor handler, and the compact form has no slider", () => {
    renderApp(<LineChart name="engine speed" unit="rpm" points={points} />);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    renderApp(<LineChart variant="compact" name="boost" unit="kPa" points={points} />);
    expect(screen.getByRole("img", { name: "Trend of boost" })).toBeInTheDocument();
  });
});

/** A test collects a run from the simulator first, which takes longer on a busy machine. */
const SLOW = 30_000;

describe("Run graphs", { timeout: SLOW }, () => {
  it("opens a stored simulator run as a chart per signal with a table of values", async () => {
    await openGraphs();
    const charts = screen.getAllByRole("figure");
    expect(charts.length).toBeGreaterThan(1);
    expect(screen.getByRole("img", { name: /^engine speed: \d+ readings/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Values at the cursor" });
    expect(within(table).getAllByRole("row").length).toBe(charts.length + 1);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
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
    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
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

  it("closes the graphs", async () => {
    await openGraphs();
    await userEvent.click(screen.getByRole("button", { name: "Close graphs" }));
    expect(screen.queryByRole("group", { name: "Run playback" })).not.toBeInTheDocument();
  });
});
