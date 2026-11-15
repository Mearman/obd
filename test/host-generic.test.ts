import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  faultEvents,
  GENERIC_PROFILE,
  GuardError,
  authoriseClear,
  permit,
  type SnapshotStore,
} from "../src/core/index.js";
import {
  FlakyHost,
  GENERIC_SIMULATOR,
  SIMULATOR,
  eventually,
  newSimulatedService,
  recordingGenericHost,
} from "./support/host-rig.js";

/** The modes a generic session may send without a clear token. */
const READ_MODES = ["01", "02", "03", "06", "07", "09", "0A"];

async function connectedGeneric() {
  const rig = recordingGenericHost();
  const service = newSimulatedService({ transports: rig.transports });
  await service.host.client.link.connect({ adapter: GENERIC_SIMULATOR });
  return { ...service, car: rig.car };
}

/** The mode (first byte as hexadecimal) of every diagnostic request the adapter received. */
const modes = (car: { requests: string[] }): string[] =>
  car.requests.map((line) => line.replaceAll(" ", "").slice(0, 2).toUpperCase());

describe("a connection with no profile", () => {
  it("opens with the legislated services only and reports no profile", async () => {
    const { host } = await connectedGeneric();
    expect(await host.client.link.status()).toMatchObject({
      profile: null,
      adapter: GENERIC_SIMULATOR,
      simulated: true,
    });
  });

  it("still opens with a profile, and a profile scan has no OBD report", async () => {
    const service = newSimulatedService();
    const connection = await service.host.client.link.connect({
      profile: "mercedes-w211",
      adapter: SIMULATOR,
    });
    expect(connection.profile).toBe("mercedes-w211");
    expect((await service.host.client.scan.run({})).obd).toBeNull();
  });

  it("scans through the legislated reads and saves the report under the generic name", async () => {
    const { host } = await connectedGeneric();
    const scanned = await host.client.scan.run({ label: "generic" });
    expect(scanned.obd).toMatchObject({
      vin: "SIMULATEDCAR00001",
      units: [
        {
          sender: "7E8",
          lampOn: true,
          codeCount: 1,
          stored: ["P0420"],
          pending: [],
          permanent: [],
          freezeFrame: { code: "P0420" },
          calibrationIds: ["SIMCAL0001"],
        },
      ],
      monitorResults: [{ sender: "7E8", value: 291, withinLimits: true }],
    });
    expect(scanned.obd?.values.map((value) => value.signal).sort()).toEqual([
      "coolant temperature",
      "engine speed",
      "vehicle speed",
    ]);
    expect(scanned.units).toMatchObject([
      {
        unit: "7E8",
        answered: true,
        faults: [{ code: "P0420", status: "stored" }],
        identification: [
          { label: "VIN", text: "SIMULATEDCAR00001" },
          { label: "Calibration identifier" },
        ],
      },
    ]);
    expect(scanned.report).toMatchObject({ profile: GENERIC_PROFILE, label: "generic" });
    const saved = await host.client.reports.get({ id: scanned.report.id });
    expect(saved.report).toMatchObject({
      profile: { name: GENERIC_PROFILE },
      obd: { vin: "SIMULATEDCAR00001" },
    });
  });

  it("collects the legislated values in a run stored under the generic name", async () => {
    const { host, storage } = await connectedGeneric();
    const run = await host.client.runs.start({ adapter: GENERIC_SIMULATOR });
    expect(run.profile).toBe(GENERIC_PROFILE);
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 3 ? true : undefined,
    );
    const aggregate = await host.client.runs.aggregate({ runId: run.id });
    expect(aggregate.map((row) => row.signal)).toEqual([
      "coolant temperature",
      "engine speed",
      "pending fault codes",
      "permanent fault codes",
      "stored fault codes",
      "vehicle speed",
    ]);
    await host.client.runs.stop({ runId: run.id });
  });

  it("records the fault codes when a run starts, when they change and when it stops", async () => {
    const rig = recordingGenericHost();
    const { host, storage } = newSimulatedService({ transports: rig.transports, codesMs: 50 });
    await host.client.link.connect({ adapter: GENERIC_SIMULATOR });
    const run = await host.client.runs.start({ adapter: GENERIC_SIMULATOR });
    const signalSamples = async (signal: string) =>
      (await storage.readSamples({ runId: run.id, signal })).map((sample) => sample.value);
    await eventually(async () =>
      (await signalSamples("stored fault codes")).length > 0 ? true : undefined,
    );
    expect(await signalSamples("stored fault codes")).toEqual(["P0420"]);
    expect(await signalSamples("pending fault codes")).toEqual(["none"]);
    expect(await signalSamples("permanent fault codes")).toEqual(["none"]);

    // The car forgets its code, as it does when another tool sends mode 04 while the run goes on.
    rig.car.responders[0x7df]?.(Uint8Array.of(0x04));
    await eventually(async () =>
      (await signalSamples("stored fault codes")).length > 1 ? true : undefined,
    );
    await host.client.runs.stop({ runId: run.id });

    expect(await signalSamples("stored fault codes")).toEqual(["P0420", "none"]);
    const events = faultEvents(await storage.readSamples({ runId: run.id }));
    expect(events.map((event) => `${event.list} ${event.code} ${event.change}`)).toEqual([
      "stored P0420 appeared",
      "stored P0420 disappeared",
    ]);
    expect(events[0]?.atStart).toBe(true);
  });

  it("starts a run on its own when nothing is connected, and releases the adapter after", async () => {
    const rig = recordingGenericHost();
    const { host, storage } = newSimulatedService({ transports: rig.transports });
    const run = await host.client.runs.start({ adapter: GENERIC_SIMULATOR });
    expect((await host.client.link.status())?.profile).toBeNull();
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 0 ? true : undefined,
    );
    await host.client.runs.stop({ runId: run.id });
    expect(await host.client.link.status()).toBeNull();
  });

  it("reconnects a generic run with no profile when the link drops", async () => {
    const transports = new FlakyHost();
    const { host, storage } = newSimulatedService({ transports });
    const run = await host.client.runs.start({ adapter: GENERIC_SIMULATOR });
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > 3 ? true : undefined,
    );
    const before = (await storage.readSamples({ runId: run.id })).length;
    transports.dropCurrent();
    await eventually(() => (transports.built.length === 2 ? true : undefined));
    await eventually(async () =>
      (await storage.readSamples({ runId: run.id })).length > before + 3 ? true : undefined,
    );
    expect((await host.client.link.status())?.profile).toBeNull();
    await host.client.runs.stop({ runId: run.id });
  });

  it("clears every emissions code through mode 04 only after the snapshot and the confirmation", async () => {
    const { host, car } = await connectedGeneric();
    const asked = await host.client.clear.request({ target: { kind: "obd" } });
    expect(asked.snapshot?.name).toContain("clear-obd");
    expect(asked.lines.join("\n")).toContain("stored codes from 7E8: P0420");
    const snapshot = await host.client.reports.get({ id: asked.snapshot?.id ?? "" });
    expect(snapshot.profile).toBe(GENERIC_PROFILE);
    expect(modes(car)).not.toContain("04");

    const outcome = await host.client.clear.confirm({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: true, exitStatus: 0 });
    expect(modes(car).filter((mode) => mode === "04")).toHaveLength(1);

    const after = await host.client.scan.run({});
    expect(after.obd?.units[0]).toMatchObject({ lampOn: false, stored: [], freezeFrame: null });
  });

  it("sends nothing that changes the car when the clear is cancelled", async () => {
    const { host, car } = await connectedGeneric();
    const asked = await host.client.clear.request({ target: { kind: "obd" } });
    await host.client.guarded.cancel({ confirmation: asked.confirmation });
    expect(modes(car)).not.toContain("04");
    expect((await host.client.scan.run({})).obd?.units[0]?.stored).toEqual(["P0420"]);
  });

  it("sends nothing but legislated read modes, and mode 04 once and only after a confirmation", async () => {
    const { host, car } = await connectedGeneric();
    await host.client.scan.run({});
    const run = await host.client.runs.start({ adapter: GENERIC_SIMULATOR });
    await host.client.runs.stop({ runId: run.id });
    await host.client.link.disconnect();
    await host.client.link.connect({ adapter: GENERIC_SIMULATOR });
    const asked = await host.client.clear.request({ target: { kind: "obd" } });
    await host.client.clear.confirm({ confirmation: asked.confirmation });
    await host.client.scan.run({});
    const sent = modes(car);
    expect(sent.length).toBeGreaterThan(20);
    expect(sent.filter((mode) => !READ_MODES.includes(mode))).toEqual(["04"]);
  });
});

describe("operations that address one unit need a profile", () => {
  const withoutTraffic = async (
    work: (host: Awaited<ReturnType<typeof connectedGeneric>>["host"]) => Promise<unknown>,
  ) => {
    const rig = await connectedGeneric();
    const sentBefore = rig.car.sent.length;
    await expect(work(rig.host)).rejects.toMatchObject({ code: "PROFILE_REQUIRED" });
    // Nothing reached the adapter, no snapshot was saved and nothing is parked on a confirmation.
    expect(rig.car.sent.length).toBe(sentBefore);
    expect(await rig.host.client.reports.list({})).toEqual([]);
    expect(await rig.host.client.runs.list({})).toEqual([]);
    await rig.host.client.link.disconnect();
  };

  it("rejects probe", () => withoutTraffic((host) => host.client.link.probe()));
  it("rejects ident", () => withoutTraffic((host) => host.client.units.ident({ unit: "engine" })));
  it("rejects faults", () =>
    withoutTraffic((host) => host.client.units.faults({ unit: "engine" })));
  it("rejects freeze", () =>
    withoutTraffic((host) => host.client.units.freeze({ unit: "engine" })));
  it("rejects a clear of one unit", () =>
    withoutTraffic((host) =>
      host.client.clear.request({ target: { kind: "unit", unit: "engine" } }),
    ));
  it("rejects a write", () =>
    withoutTraffic((host) =>
      host.client.write.request({ unit: "engine", request: "3B 99 00 02", read: "21 99" }),
    ));
  it("rejects an actuator test", () =>
    withoutTraffic((host) =>
      host.client.actuate.request({
        unit: "engine",
        request: "30 20 07 01",
        stop: "30 20 00",
        durationMs: 100,
      }),
    ));
  it("rejects a run that names a unit", () =>
    withoutTraffic((host) =>
      host.client.runs.start({ adapter: GENERIC_SIMULATOR, unit: "engine" }),
    ));

  it("explains the refusal in one line", async () => {
    const { host } = await connectedGeneric();
    const failure = await host.client.units
      .faults({ unit: "engine" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "PROFILE_REQUIRED" });
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /^reading one unit needs a vehicle profile[^\n]*$/,
    );
  });

  it("keeps the generic name for connections with no profile", async () => {
    const { host } = newSimulatedService();
    const json = JSON.stringify({
      name: GENERIC_PROFILE,
      description: "x",
      status: "unconfirmed",
      bus: { id_bits: 11, bitrate: 500000 },
      diagnostics: { protocol: "kwp2000", session: 146 },
      units: { engine: { description: "e", request: 2016, response: 2024, source: "s" } },
    });
    await expect(host.client.profiles.import({ json })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("the guard behind a generic session", () => {
  const empty: SnapshotStore = {
    exists: () => Promise.resolve(false),
    size: () => Promise.reject(new Error("none")),
    readText: () => Promise.reject(new Error("none")),
  };

  it("passes only the legislated read modes without a token, in every mode", async () => {
    for (let mode = 0; mode < 0x100; mode++) {
      const request = Uint8Array.of(mode, 0x00);
      const hex = mode.toString(16).toUpperCase().padStart(2, "0");
      if (READ_MODES.includes(hex)) {
        await expect(permit(DiagProtocol.OBD, request)).resolves.toBeDefined();
      } else {
        await expect(permit(DiagProtocol.OBD, request)).rejects.toThrow(GuardError);
      }
    }
  });

  it("passes mode 04 only with a clear token, which needs a saved snapshot", async () => {
    await expect(permit(DiagProtocol.OBD, Uint8Array.of(0x04))).rejects.toThrow(GuardError);
    await expect(authoriseClear(empty, "none")).rejects.toThrow(GuardError);
  });
});
