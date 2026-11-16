import { openSection } from "./ui-helpers";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GENERIC_SIMULATOR_URL, type Sample } from "obd-read";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import type { AppService } from "../src/diagnostics/client";
import { SATURATED_NOTE } from "../src/format/saturation";
import { LivePanel } from "../src/session/LivePanel";
import { createTestService, renderApp } from "./render";

const SUPPORT: BrowserSupport = {
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

async function openLive(service: AppService = createTestService()): Promise<void> {
  await renderApp(<App support={SUPPORT} />, service);
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
  await openSection("Live");
}

/** `target` with the named members replaced, everything else passed through. */
function patched<T extends object>(target: T, replacements: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get: (object, key) =>
      key in replacements ? Reflect.get(replacements, key) : Reflect.get(object, key),
  });
}

/** The service with `runs.stop` held until the test lets it go, to see what the page says in between. */
function holdingStop(service: AppService): { service: AppService; release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs = patched(service.client.runs, {
    stop: async (input: { runId: string }) => {
      await gate;
      return service.client.runs.stop(input);
    },
  });
  return { service: { ...service, client: patched(service.client, { runs }) }, release };
}

/** The service whose run reports `progress` and never delivers a reading, as an adapter does during its first round. */
function slowFirstRound(service: AppService): AppService {
  const runs = patched(service.client.runs, {
    status: async (input: { runId: string }) => {
      const status = await service.client.runs.status(input);
      return status === null
        ? null
        : { ...status, progress: { position: 2, total: 5, label: "engine speed" } };
    },
  });
  const live = patched(service.client.live, {
    samples: () =>
      Promise.resolve(
        (async function* () {
          yield* [];
          await new Promise<never>(() => undefined);
        })(),
      ),
  });
  return { ...service, client: patched(service.client, { runs, live }) };
}

/** The service whose run delivers only the readings the test sends, so a test decides what arrives and when. */
function sendingReadings(service: AppService): {
  service: AppService;
  send: (reading: { signal: string; unit: string; timestamp: number; value: number }) => void;
} {
  const waiting: ((reading: Omit<Sample, "runId">) => void)[] = [];
  const queued: Omit<Sample, "runId">[] = [];
  const next = (): Promise<Omit<Sample, "runId">> => {
    const reading = queued.shift();
    return reading === undefined
      ? new Promise((resolve) => waiting.push(resolve))
      : Promise.resolve(reading);
  };
  const live = patched(service.client.live, {
    samples: (input: { runId: string }) =>
      Promise.resolve(
        (async function* () {
          for (;;) yield { ...(await next()), runId: input.runId };
        })(),
      ),
  });
  return {
    service: { ...service, client: patched(service.client, { live }) },
    send: (reading) => {
      const resolve = waiting.shift();
      if (resolve === undefined) queued.push(reading);
      else resolve(reading);
    },
  };
}

/** The engine speed signal the trend tests send readings of. */
const SPEED = { signal: "engine speed", unit: "rpm" } as const;

/** The text summary of the engine speed trend, once it is shown. */
async function trendSummary(): Promise<string> {
  const trend = await screen.findByRole("img", { name: "Trend of engine speed" });
  return trend.getAttribute("aria-description") ?? "";
}

/** The Live panel with a button that unmounts and mounts it again, as the shared-link viewer or an error boundary reset does. */
function Remountable() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShown(!shown);
        }}
      >
        {shown ? "Hide Live" : "Show Live"}
      </button>
      {shown && <LivePanel />}
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("the value picker", () => {
  it("lists what the car supports, starts on the Engine preset and records only the choice", async () => {
    const service = createTestService();
    await openLive(service);
    const engine = await screen.findByRole("button", { name: "Engine" });
    expect(engine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "engine speed" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "coolant temperature" })).toBeChecked();
    expect(screen.getByText(/A round of 3 values/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "coolant temperature" }));
    expect(screen.getByRole("button", { name: "Engine" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Start collecting" }));
    expect(await screen.findByText("engine speed")).toBeInTheDocument();
    const [run] = await service.client.runs.list({});
    const samples = await service.client.runs.samples({ runId: run?.id ?? "" });
    expect(new Set(samples.map((sample) => sample.signal))).toEqual(
      new Set(["engine speed", "vehicle speed"]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("cannot start with nothing chosen, and Everything chooses every supported value", async () => {
    await openLive();
    await userEvent.click(await screen.findByRole("button", { name: "Fuel and mixture" }));
    expect(screen.getByText("Nothing is chosen, so a run cannot start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start collecting" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Start collecting" })).toBeEnabled();
  });

  it("remembers the choice for the next visit, and carries on when storage refuses", async () => {
    await openLive();
    await userEvent.click(await screen.findByRole("checkbox", { name: "vehicle speed" }));
    expect(JSON.parse(window.localStorage.getItem("obd.live.selection") ?? "null")).toEqual([
      "coolant-temperature",
      "engine-speed",
    ]);
  });

  it("falls back to the Engine preset when the remembered names are damaged", async () => {
    window.localStorage.setItem("obd.live.selection", "{not json");
    window.localStorage.setItem("obd.live.pins", JSON.stringify([1, "vehicle speed"]));
    await openLive();
    expect(await screen.findByRole("button", { name: "Engine" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("collecting", () => {
  it("says which value it is reading before the first reading arrives", async () => {
    await openLive(slowFirstRound(createTestService()));
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    expect(await screen.findByText("Reading value 2 of 5: engine speed")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the first reading…")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("keeps the trend history of the run when the Live panel is unmounted and mounted again", async () => {
    const sending = sendingReadings(createTestService());
    await sending.service.client.link.connect({ adapter: GENERIC_SIMULATOR_URL });
    await renderApp(<Remountable />, sending.service);
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    for (const [timestamp, value] of [
      [1_000, 800],
      [2_000, 900],
    ] as const) {
      await act(async () => {
        sending.send({ ...SPEED, timestamp, value });
        await Promise.resolve();
      });
      await screen.findByText(String(value));
    }
    expect(await trendSummary()).toContain("2 readings");

    await userEvent.click(screen.getByRole("button", { name: "Hide Live" }));
    expect(screen.queryByRole("img", { name: "Trend of engine speed" })).not.toBeInTheDocument();
    await act(async () => {
      sending.send({ ...SPEED, timestamp: 3_000, value: 1_000 });
      await Promise.resolve();
    });
    await userEvent.click(screen.getByRole("button", { name: "Show Live" }));

    await vi.waitFor(async () => {
      const summary = await trendSummary();
      expect(summary).toContain("3 readings");
      expect(summary).toContain("starting at 800");
    });
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("puts every reading in the trend, including those that arrive between two renders", async () => {
    const sending = sendingReadings(createTestService());
    await openLive(sending.service);
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await act(async () => {
      sending.send({ ...SPEED, timestamp: 1_000, value: 800 });
      sending.send({ ...SPEED, timestamp: 2_000, value: 900 });
      sending.send({ ...SPEED, timestamp: 3_000, value: 1_000 });
      await Promise.resolve();
    });
    await vi.waitFor(async () => {
      expect(await trendSummary()).toContain("3 readings");
    });
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("shows Stopping at once and ends the run when the request in flight is answered", async () => {
    const held = holdingStop(createTestService());
    await openLive(held.service);
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
    const button = screen.getByRole("button", { name: "Stopping…" });
    expect(button).toBeDisabled();
    expect(screen.getAllByText("Stopping…").length).toBeGreaterThan(1);

    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    const table = await screen.findByRole("table", { name: "Library" });
    expect(within(table).getByText("Stopping…")).toBeInTheDocument();
    expect(within(table).queryByText("Collecting")).not.toBeInTheDocument();

    await act(async () => {
      held.release();
      await Promise.resolve();
    });
    expect(await within(table).findByText("Stopped")).toBeInTheDocument();
  });
});

describe("reading the table", () => {
  it("prints a temperature in whole degrees", async () => {
    const service = createTestService();
    await openLive(service);
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");
    const row = screen.getByText("coolant temperature").closest("[role=row]");
    if (!(row instanceof HTMLElement)) throw new Error("the coolant row is missing");
    const shown = within(row).getAllByRole("cell")[1]?.textContent ?? "";
    expect(shown).toMatch(/^-?\d+$/);
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("says a counter at its field's maximum is higher, and leaves a counter below it plain", async () => {
    const sending = sendingReadings(createTestService());
    await openLive(sending.service);
    sending.send({
      signal: "distance since codes cleared",
      unit: "km",
      timestamp: 0,
      value: 65_535,
    });
    sending.send({ signal: "time since codes cleared", unit: "min", timestamp: 0, value: 65_534 });
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("time since codes cleared");
    const reading = (signal: string): string => {
      const row = screen.getByText(signal).closest("[role=row]");
      if (!(row instanceof HTMLElement)) throw new Error(`the ${signal} row is missing`);
      return within(row).getAllByRole("cell")[1]?.textContent ?? "";
    };
    expect(reading("distance since codes cleared")).toContain(SATURATED_NOTE);
    expect(reading("time since codes cleared")).not.toContain(SATURATED_NOTE);
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });

  it("groups under headings, filters by search and keeps pinned values on top, remembered", async () => {
    await openLive();
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");
    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Search values" }), "SPEED");
    expect(screen.queryByText("coolant temperature")).not.toBeInTheDocument();
    expect(screen.getByText("vehicle speed")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search values" }), "xyz");
    expect(screen.getByText("No value matches the search.")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Search values" }));

    await userEvent.click(screen.getByRole("button", { name: "Pin vehicle speed" }));
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings.indexOf("Pinned")).toBeLessThan(headings.indexOf("Engine"));
    expect(screen.getByRole("button", { name: "Unpin vehicle speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(JSON.parse(window.localStorage.getItem("obd.live.pins") ?? "null")).toEqual([
      "vehicle speed",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });
});
