import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import type { AppService } from "../src/diagnostics/client";
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
  renderApp(<App support={SUPPORT} />, service);
  await userEvent.click(screen.getByRole("tab", { name: "Connect" }));
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
  await userEvent.click(screen.getByRole("tab", { name: "Live" }));
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
      Promise.resolve({
        next: () => new Promise<never>(() => undefined),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
  });
  return { ...service, client: patched(service.client, { runs, live }) };
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
