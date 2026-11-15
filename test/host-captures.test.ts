import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureText, type CaptureStatus } from "../src/core/index.js";
import { builtinProfileData } from "../src/profiles/index.js";
import {
  GENERIC_SIMULATOR,
  SIMULATOR,
  eventually,
  newSimulatedService,
} from "./support/host-rig.js";

async function connected(profile: string | undefined, adapter = SIMULATOR) {
  const service = newSimulatedService();
  await service.host.client.link.connect({
    ...(profile === undefined ? {} : { profile }),
    adapter,
  });
  return service;
}

/** Waits for a capture to end and returns its last status. */
async function finished(
  client: ReturnType<typeof newSimulatedService>["host"]["client"],
  id: string,
): Promise<CaptureStatus> {
  return eventually(async () => {
    const status = await client.captures.status({ id });
    return status !== null && status.state !== "capturing" ? status : undefined;
  });
}

describe("captures through the service", () => {
  it("captures everything, streams progress, stores it, and decodes it under any profile", async () => {
    const { host } = await connected("mercedes-w211");
    const started = await host.client.captures.start({});
    expect(started.state).toBe("capturing");
    const seen: CaptureStatus[] = [];
    for await (const status of await host.client.captures.progress({ id: started.id })) {
      seen.push(status);
    }
    const last = seen.at(-1);
    expect(last?.state).toBe("saved");
    expect(seen.some((status) => status.step === "units")).toBe(true);
    expect(last?.summary?.profile).toBe("mercedes-w211");
    expect(last?.summary?.complete).toBe(true);
    expect((await host.client.captures.list({})).map((capture) => capture.id)).toEqual([
      started.id,
    ]);
    const stored = await host.client.captures.get({ id: started.id });
    expect(stored.sessions[0]?.tool).toEqual({ name: "obd-read", version: "test" });

    const asW211 = await host.client.captures.decode({ id: started.id, profile: "mercedes-w211" });
    const asMqb = await host.client.captures.decode({ id: started.id, profile: "vag-mqb" });
    const generic = await host.client.captures.decode({ id: started.id, profile: null });
    expect(asW211.units.find((unit) => unit.unit === "esp")?.faults).toEqual([
      { code: "1234", status: "20" },
    ]);
    expect(asMqb.units.find((unit) => unit.unit === "gateway")?.notes).toEqual([
      "not in this capture",
    ]);
    expect(generic.units).toEqual([]);
    expect(generic.undecoded.length).toBeGreaterThan(asW211.undecoded.length);
    expect(generic.lines[0]).toBe("decoded with no profile: the legislated OBD-II reads only");
  });

  it("re-decodes an old capture after a profile is imported", async () => {
    const { host } = await connected("mercedes-w211");
    const { id } = await host.client.captures.start({
      identifiers: { first: 0x98, last: 0x99, budget: 100, pauseMs: 10 },
    });
    await finished(host.client, id);
    const document = builtinProfileData("mercedes-w211");
    if (typeof document !== "object" || document === null) throw new Error("no profile");
    const before = await host.client.captures.decode({ id, profile: "mercedes-w211" });
    expect(before.values).toEqual([]);
    const updated: unknown = JSON.parse(JSON.stringify(document));
    if (typeof updated !== "object" || updated === null) throw new Error("no profile");
    const units: unknown = Reflect.get(updated, "units");
    if (typeof units !== "object" || units === null) throw new Error("no units");
    const engine: unknown = Reflect.get(units, "engine");
    if (typeof engine !== "object" || engine === null) throw new Error("no engine");
    Reflect.set(engine, "values", {
      record: { label: "invented record", identifier: 0x99, size: 2, source: "test" },
    });
    Reflect.set(updated, "name", "w211-with-record");
    await host.client.profiles.import({ json: JSON.stringify(updated) });
    const after = await host.client.captures.decode({ id, profile: "w211-with-record" });
    expect(after.values.map(({ unit, label, value }) => ({ unit, label, value }))).toEqual([
      { unit: "engine", label: "invented record", value: 1 },
    ]);
  });

  it("sweeps for units on a generic connection", async () => {
    const { host } = await connected(undefined, GENERIC_SIMULATOR);
    const { id } = await host.client.captures.start({
      discovery: { first: 0x7e0, last: 0x7e0, protocols: ["kwp2000"] },
    });
    const status = await finished(host.client, id);
    expect(status.summary?.profile).toBeNull();
    expect(status.summary?.units.map((unit) => unit.label)).toContain("7E0 -> any");
  });

  it("stops a capture, saving it as incomplete", async () => {
    const { host } = await connected("mercedes-w211");
    const { id } = await host.client.captures.start({
      identifiers: { first: 0x00, last: 0xff, budget: 20_000, pauseMs: 10 },
    });
    await eventually(async () => {
      const status = await host.client.captures.status({ id });
      return status?.step === "identifiers" ? status : undefined;
    });
    expect((await host.client.captures.stop({ id })).stopping).toBe(true);
    const status = await finished(host.client, id);
    expect(status.state).toBe("saved");
    expect(status.summary?.complete).toBe(false);
  });

  it("holds the adapter while capturing and needs a connection", async () => {
    const idle = newSimulatedService();
    await expect(idle.host.client.captures.start({})).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const { host } = await connected("mercedes-w211");
    const { id } = await host.client.captures.start({
      identifiers: { first: 0x00, last: 0xff, budget: 20_000, pauseMs: 10 },
    });
    await expect(host.client.captures.start({})).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(host.client.scan.run({})).rejects.toMatchObject({ code: "CONFLICT" });
    await host.client.captures.stop({ id });
    await finished(host.client, id);
    await expect(host.client.captures.stop({ id: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a sweep outside the guard's rules", async () => {
    const { host } = await connected("mercedes-w211");
    await expect(
      host.client.captures.start({
        identifiers: { first: 0, last: 1, budget: 1, pauseMs: 0 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("imports a capture file, a saved scan or a transcript, and deletes", async () => {
    const { host } = newSimulatedService();
    const lines = readFileSync(new URL("fixtures/a150-since-clear.txt", import.meta.url), "utf8");
    const imported = await host.client.captures.import({ text: lines, name: "a150.log" });
    expect(imported.unrecovered).toEqual([]);
    expect(imported.summary.kind).toBe("import");
    const decoded = await host.client.captures.decode({ id: imported.summary.id, profile: null });
    expect(decoded.obd?.units.map((unit) => unit.sender)).toEqual(["7E8"]);

    const capture = await host.client.captures.get({ id: imported.summary.id });
    await expect(
      host.client.captures.import({ text: captureText(capture), name: "again.obdcap.json" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      host.client.captures.import({ text: '{"format":"obd-read-capture","version":9}', name: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await host.client.captures.delete({ id: imported.summary.id })).toEqual({
      deleted: true,
    });
    expect(await host.client.captures.delete({ id: imported.summary.id })).toEqual({
      deleted: false,
    });
    await expect(host.client.captures.get({ id: imported.summary.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
