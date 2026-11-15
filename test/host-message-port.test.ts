import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  adapterTransport,
  createDiagnosticsService,
  simulatedLiveCar,
} from "../src/core/index.js";
import { loadBuiltinProfile } from "../src/profiles/index.js";
import { connectDiagnostics, serveDiagnostics } from "../src/service/message-port.js";
import { remoteTransportHost, serveTransports } from "../src/service/transport-link.js";
import { eventually, turn } from "./support/host-rig.js";

/** The worker's side and the page's side wired by two message channels, with the page owning a simulated Bluetooth adapter. */
function workerAndPage() {
  const diagnostics = new MessageChannel();
  const transports = new MessageChannel();
  serveTransports(transports.port1, () =>
    adapterTransport(simulatedLiveCar(loadBuiltinProfile("mercedes-w211"))),
  );
  const service = createDiagnosticsService({
    toolVersion: "test",
    storage: new MemoryStorage(),
    loadProfile: (name) => Promise.resolve(loadBuiltinProfile(name)),
    transports: remoteTransportHost(transports.port2, ["webbluetooth"]),
    sleep: turn,
    timing: { pollMs: 0, flushMs: 0, batchSize: 1, reconnectDelay: () => 0 },
  });
  serveDiagnostics(service.host, diagnostics.port1);
  return {
    client: connectDiagnostics(diagnostics.port2),
    dispose: () => {
      for (const port of [
        diagnostics.port1,
        diagnostics.port2,
        transports.port1,
        transports.port2,
      ]) {
        port.close();
      }
    },
  };
}

describe("the service in a worker, with Bluetooth on the page", () => {
  it("scans through a transport that lives on the other side of a port", async () => {
    const { client, dispose } = workerAndPage();
    try {
      const connection = await client.link.connect({
        profile: "mercedes-w211",
        adapter: "webbluetooth://vLinker",
      });
      expect(connection.simulated).toBe(false);
      const scan = await client.scan.run({});
      expect(scan.units.some((unit) => unit.answered)).toBe(true);
      expect((await client.adapters.list()).find((a) => a.scheme === "webbluetooth")).toMatchObject(
        { available: true },
      );
      await client.link.disconnect();
    } finally {
      dispose();
    }
  });

  it("collects a run and streams its samples across both hops", async () => {
    const { client, dispose } = workerAndPage();
    try {
      const run = await client.runs.start({
        profile: "mercedes-w211",
        adapter: "webbluetooth://vLinker",
      });
      const live = await client.live.samples({ runId: run.id });
      const first = await live.next();
      expect(first.value).toMatchObject({ runId: run.id });
      await live.return();
      await eventually(async () =>
        (await client.runs.samples({ runId: run.id })).length > 3 ? true : undefined,
      );
      await client.runs.stop({ runId: run.id });
    } finally {
      dispose();
    }
  });

  it("carries the two-step clear across the port and refuses a replayed confirmation", async () => {
    const { client, dispose } = workerAndPage();
    try {
      await client.link.connect({ profile: "mercedes-w211", adapter: "webbluetooth://vLinker" });
      const asked = await client.clear.request({ target: { kind: "unit", unit: "engine" } });
      expect(asked.snapshot).not.toBeNull();
      await client.clear.confirm({ confirmation: asked.confirmation });
      await expect(
        client.clear.confirm({ confirmation: asked.confirmation }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await client.units.faults({ unit: "engine" })).faults).toEqual([]);
    } finally {
      dispose();
    }
  });
});
