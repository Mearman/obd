import { describe, expect, it } from "vitest";
import { MemoryStorage, type Sample } from "../src/core/index.js";
import { FlakyHost, SIMULATOR, eventually, newSimulatedService, turn } from "./support/host-rig.js";

const STORED_FAULT_CODE = "1234";

async function connected(service = newSimulatedService()) {
  await service.host.client.link.connect({ profile: "mercedes-w211", adapter: SIMULATOR });
  return service;
}

describe("reading through the host", () => {
  it("connects to the simulator, reports it as simulated and disconnects", async () => {
    const { host } = newSimulatedService();
    expect(await host.client.link.status()).toBeNull();
    const connection = await host.client.link.connect({
      profile: "mercedes-w211",
      adapter: SIMULATOR,
    });
    expect(connection).toMatchObject({ profile: "mercedes-w211", simulated: true });
    expect(await host.client.link.status()).toEqual(connection);
    await expect(
      host.client.link.connect({ profile: "mercedes-w211", adapter: SIMULATOR }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await host.client.link.disconnect()).toEqual({ disconnected: true });
    expect(await host.client.link.status()).toBeNull();
  });

  it("needs a connection for every read of the car", async () => {
    const { host } = newSimulatedService();
    await expect(host.client.link.probe()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(host.client.units.faults({ unit: "engine" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(host.client.battery.voltage()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("probes units, reads identification, faults and freeze frames, and the supply voltage", async () => {
    const { host } = await connected();
    const probe = await host.client.link.probe();
    expect(probe.units.length).toBeGreaterThan(0);
    expect(probe.units.every((unit) => unit.answered && unit.faults === null)).toBe(true);

    const ident = await host.client.units.ident({ unit: "engine" });
    expect(ident.identification.length).toBeGreaterThan(0);
    expect(ident.faults).toBeNull();

    const faults = await host.client.units.faults({ unit: "engine" });
    expect(faults.faults?.map((fault) => fault.code)).toEqual([STORED_FAULT_CODE]);

    const freeze = await host.client.units.freeze({ unit: "engine" });
    expect(Object.keys(freeze.freezeFrames)).toEqual([STORED_FAULT_CODE]);

    expect(await host.client.battery.voltage()).toEqual({ volts: 12.4 });
    await expect(host.client.units.ident({ unit: "no-such-unit" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("scans every unit and saves the report", async () => {
    const { host } = await connected();
    const scan = await host.client.scan.run({ label: "before" });
    expect(scan.units.some((unit) => unit.faults?.length === 1)).toBe(true);
    expect(await host.client.reports.list({})).toEqual([scan.report]);
    const stored = await host.client.reports.get({ id: scan.report.id });
    expect(stored.label).toBe("before");
    expect(stored.report).toMatchObject({ tool: "obd-read", profile: { name: "mercedes-w211" } });
    await expect(host.client.reports.get({ id: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("listening to the bus", () => {
  const capture = { adapter: SIMULATOR, idBits: 11, bitrate: 500_000, durationMs: 50 } as const;

  it("captures for a limited time without transmitting and reports the frame count", async () => {
    const { host } = newSimulatedService();
    const { lines } = await host.client.monitor.capture(capture);
    expect(lines.at(-1)).toBe("0 frames logged");
    expect(lines.join("\n")).toContain("monitoring with");
  });

  it("needs the adapter free", async () => {
    const { host } = await connected();
    await expect(host.client.monitor.capture(capture)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("collecting a run", () => {
  it("stores samples and streams them live, then stops and releases the adapter", async () => {
    const service = newSimulatedService();
    const { host, storage } = service;
    const run = await host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR });
    expect(run.notes).toBe("");
    const live = await host.client.live.samples({ runId: run.id });
    const first = await live.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ runId: run.id });

    await eventually(async () => {
      const aggregate = await host.client.runs.aggregate({ runId: run.id });
      return aggregate.length === 3 && aggregate.every((row) => row.count >= 3)
        ? aggregate
        : undefined;
    });
    const aggregate = await host.client.runs.aggregate({ runId: run.id });
    expect(aggregate.map((row) => row.signal)).toEqual([
      "coolant temperature",
      "engine speed",
      "vehicle speed",
    ]);
    const rpm = aggregate.find((row) => row.signal === "engine speed");
    expect(rpm).toMatchObject({ unit: "rpm" });
    expect(rpm?.min).not.toBe(rpm?.max);
    expect(await host.client.runs.status({ runId: run.id })).toMatchObject({
      state: "collecting",
    });
    await live.return();

    const stopped = await host.client.runs.stop({ runId: run.id });
    expect(stopped.stoppedAt).not.toBeNull();
    expect(await host.client.runs.status({ runId: run.id })).toBeNull();
    expect(await host.client.link.status()).toBeNull();
    const stored = (await storage.readSamples({ runId: run.id })).length;
    for (let pass = 0; pass < 20; pass++) await turn();
    expect((await storage.readSamples({ runId: run.id })).length).toBe(stored);
  });

  it("collects one unit's profile values when the run names a unit", async () => {
    const { host } = newSimulatedService();
    await expect(
      host.client.runs.start({
        profile: "mercedes-w211",
        adapter: SIMULATOR,
        unit: "engine",
        signals: ["no-such-value"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await host.client.runs.list({})).toEqual([]);
    expect(await host.client.link.status()).toBeNull();
  });

  it("keeps the adapter to the run and refuses a second run while one collects", async () => {
    const { host } = newSimulatedService();
    const run = await host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR });
    await expect(
      host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(host.client.link.probe()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(host.client.clear.request({ target: { kind: "obd" } })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await host.client.runs.list({})).toHaveLength(1);
    await host.client.runs.stop({ runId: run.id });
  });

  it("reconnects with backoff when the link drops and carries on storing samples", async () => {
    const transports = new FlakyHost();
    const { host, storage } = newSimulatedService({ transports });
    const run = await host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 3 ? true : undefined,
    );
    const before = (await storage.readSamples({ runId: run.id })).length;

    transports.dropCurrent();
    await eventually(() => (transports.built.length === 2 ? true : undefined));
    await eventually(async () => {
      const status = await host.client.runs.status({ runId: run.id });
      return status?.state === "collecting" && status.lastError === "the link dropped"
        ? status
        : undefined;
    });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > before + 3 ? true : undefined,
    );
    await host.client.runs.stop({ runId: run.id });
  });

  it("ends a run it cannot recover as failed and leaves it open", async () => {
    const service = newSimulatedService();
    const { host, storage } = service;
    const run = await host.client.runs.start({ profile: "mercedes-w211", adapter: SIMULATOR });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 0 ? true : undefined,
    );
    // A profile removed from under the collector is not a link drop.
    await storage.stopRun(run.id, service.clock.time + 1);
    const status = await eventually(async () => {
      const current = await host.client.runs.status({ runId: run.id });
      return current?.state === "failed" ? current : undefined;
    });
    expect(status.lastError).toMatch(/stopped/);
    await expect(host.client.runs.stop({ runId: run.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await host.client.runs.status({ runId: run.id })).toBeNull();
  });

  it("resumes an open run after a reload from the stored run record", async () => {
    const storage = new MemoryStorage();
    const before = newSimulatedService({ storage });
    const run = await before.host.client.runs.start({
      profile: "mercedes-w211",
      adapter: SIMULATOR,
      signals: ["engine-speed"],
      notes: "idle",
    });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 2 ? true : undefined,
    );
    // The page reloads: the old service and its collector are gone, the stored run is not.
    const stored = (await storage.readSamples({ runId: run.id })).length;
    const after = newSimulatedService({ storage });
    const open = (await after.host.client.runs.list({})).filter(
      (entry) => entry.stoppedAt === null,
    );
    expect(open.map((entry) => [entry.id, entry.notes])).toEqual([[run.id, "idle"]]);

    await after.host.client.runs.resume({ runId: run.id });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > stored + 2 ? true : undefined,
    );
    const signals = new Set(
      (await storage.readSamples({ runId: run.id })).map((sample: Sample) => sample.signal),
    );
    expect([...signals]).toEqual(["engine speed"]);
    await after.host.client.runs.stop({ runId: run.id });
    await expect(after.host.client.runs.resume({ runId: run.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(after.host.client.runs.resume({ runId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
