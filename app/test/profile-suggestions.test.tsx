import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import { fakeControl, readySession } from "./fake-database";
import { createTestService, renderApp } from "./render";
import { openSection, pickProfile } from "./ui-helpers";

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

/** A made-up VIN whose WMI no shipped profile names. The simulated car's own VIN holds an I, which no real VIN may, so it suggests nothing. */
const VIN = "XY900000000000000";

/** The client with a generic read's VIN replaced by {@link VIN}. */
function reportingVin(client: DiagnosticsClient): DiagnosticsClient {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      const isObject = typeof value === "function" || (typeof value === "object" && value !== null);
      if (key !== "scan" || !isObject) return value;
      return new Proxy(value, {
        get: (inner, method): unknown =>
          method === "run"
            ? async (input: Parameters<DiagnosticsClient["scan"]["run"]>[0]) => {
                const result = await target.scan.run(input);
                return { ...result, obd: result.obd === null ? null : { ...result.obd, vin: VIN } };
              }
            : Reflect.get(inner, method),
      });
    },
  });
}

/** An imported profile for the maker {@link VIN} names. */
const SIMULATED_MAKER = JSON.stringify({
  name: "simulated-maker",
  description: "Cars from the simulator's invented maker",
  status: "unconfirmed",
  vin: { wmi: ["XY9"], source: "made up for the test" },
  bus: { id_bits: 11, bitrate: 500000 },
  diagnostics: { protocol: "uds", session: 0x03 },
  units: {
    engine: { description: "Engine", request: 0x7e0, response: 0x7e8, source: "made up" },
  },
});

async function genericScan(importProfile: boolean): Promise<void> {
  const service = createTestService();
  if (importProfile) await service.client.profiles.import({ json: SIMULATED_MAKER });
  await renderApp(
    <App support={CHROME} />,
    { ...service, client: reportingVin(service.client) },
    readySession(fakeControl(), service.storage),
  );
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
  await openSection("Read");
  await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
  await screen.findByRole("button", { name: "Share scan" });
}

describe("the profile a generic read's VIN suggests", () => {
  it("is offered on the Read and Connection sections and chosen only on the person's say", async () => {
    await genericScan(true);
    for (const section of ["Read", "Connection"] as const) {
      await openSection(section);
      const offers = await screen.findAllByRole("list", { name: "Profiles for this VIN" });
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(within(offer).getByText("simulated-maker")).toBeVisible();
        expect(within(offer).getByText(/Only the maker in the VIN matches/)).toBeVisible();
      }
    }
    const [first] = await screen.findAllByRole("list", { name: "Profiles for this VIN" });
    // Shown and not acted on: the connection stays generic until the person chooses.
    expect(screen.getByText("Connected to Simulator")).toBeVisible();

    if (first === undefined) throw new Error("no offer");
    await userEvent.click(within(first).getByRole("button", { name: "Use simulated-maker" }));
    expect(
      await screen.findByRole("button", { name: /connect with the simulator/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Vehicle profile/ })).toHaveTextContent(
      "simulated-maker",
    );
    expect(screen.queryByRole("list", { name: "Profiles for this VIN" })).toBeNull();
  });

  it("is not offered when no profile names the VIN's maker", async () => {
    await genericScan(false);
    expect(screen.queryByRole("list", { name: "Profiles for this VIN" })).toBeNull();
  });

  it("is not offered on a profile connection", async () => {
    const service = createTestService();
    await service.client.profiles.import({ json: SIMULATED_MAKER });
    await renderApp(
      <App support={CHROME} />,
      { ...service, client: reportingVin(service.client) },
      readySession(fakeControl(), service.storage),
    );
    await pickProfile("simulated-maker");
    await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
    await screen.findByText("Connected to Simulator");
    await openSection("Read");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    await screen.findByRole("button", { name: "Share scan" });
    expect(screen.queryByRole("list", { name: "Profiles for this VIN" })).toBeNull();
  });
});
