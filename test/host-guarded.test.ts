import { describe, expect, it } from "vitest";
import { SIMULATOR, newSimulatedService, turn } from "./support/host-rig.js";

async function connected(options: Parameters<typeof newSimulatedService>[0] = {}) {
  const service = newSimulatedService(options);
  await service.host.client.link.connect({ profile: "mercedes-w211", adapter: SIMULATOR });
  return service;
}

const faultCount = async (service: Awaited<ReturnType<typeof connected>>): Promise<number> =>
  (await service.host.client.units.faults({ unit: "engine" })).faults?.length ?? -1;

describe("clearing codes takes two calls", () => {
  it("shows what would be sent and the saved snapshot, and changes nothing until confirmed", async () => {
    const service = await connected();
    const { client } = service.host;
    const asked = await client.clear.request({ target: { kind: "unit", unit: "engine" } });
    expect(asked.snapshot?.name).toContain("clear-engine");
    expect(asked.lines.join("\n")).toContain("snapshot saved");
    expect(asked.prompt).toMatch(/Erase these fault codes from engine/);
    expect(asked.confirmation).not.toBe("");

    const saved = await client.reports.get({ id: asked.snapshot?.id ?? "" });
    expect(saved.report).toMatchObject({ units: [{ unit: "engine", faults: [{ code: "1234" }] }] });

    // The adapter is parked on the question: nothing else may use it, and the car is untouched.
    await expect(client.link.probe()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.clear.request({ target: { kind: "obd" } })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const outcome = await client.clear.confirm({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: true, exitStatus: 0 });
    expect(outcome.lines.join("\n")).toContain("cleared; reading the unit again");
    expect(await faultCount(service)).toBe(0);
  });

  it("leaves the codes and keeps the snapshot when the request is cancelled", async () => {
    const service = await connected();
    const { client } = service.host;
    const asked = await client.clear.request({ target: { kind: "unit", unit: "engine" } });
    const outcome = await client.guarded.cancel({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: false, exitStatus: 1 });
    expect(outcome.lines.join("\n")).toContain("nothing cleared");
    expect(await faultCount(service)).toBe(1);
    expect(await client.reports.list({})).toHaveLength(1);
  });

  it("passes a confirmation once and refuses an unknown or answered id", async () => {
    const service = await connected();
    const { client } = service.host;
    await expect(client.clear.confirm({ confirmation: "invented" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const asked = await client.clear.request({ target: { kind: "unit", unit: "engine" } });
    await client.clear.confirm({ confirmation: asked.confirmation });
    await expect(client.clear.confirm({ confirmation: asked.confirmation })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.guarded.cancel({ confirmation: asked.confirmation })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });

  it("does not let a clear confirmation answer a write or an actuator request", async () => {
    const service = await connected();
    const { client } = service.host;
    const asked = await client.clear.request({ target: { kind: "unit", unit: "engine" } });
    await expect(client.write.confirm({ confirmation: asked.confirmation })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client.actuate.confirm({ confirmation: asked.confirmation }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await service.host.client.guarded.cancel({ confirmation: asked.confirmation }),
    ).toMatchObject({ confirmed: false });
    expect(await faultCount(service)).toBe(1);
  });

  it("needs a connection, and expires a request nobody answers", async () => {
    const idle = newSimulatedService();
    await expect(idle.host.client.clear.request({ target: { kind: "obd" } })).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );

    const service = await connected({ confirmationTtlMs: 10 });
    const asked = await service.host.client.clear.request({
      target: { kind: "unit", unit: "engine" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(
      service.host.client.clear.confirm({ confirmation: asked.confirmation }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await faultCount(service)).toBe(1);
    // The adapter is free again.
    await service.host.client.link.probe();
  });

  it("clears the legislated codes of every unit through mode 04 after a confirmation", async () => {
    const service = await connected();
    const { client } = service.host;
    const asked = await client.clear.request({ target: { kind: "obd" } });
    expect(asked.lines.join("\n")).toMatch(/stored codes from/);
    expect(asked.prompt).toMatch(/Erase them/);
    expect(asked.snapshot).not.toBeNull();
    await client.guarded.cancel({ confirmation: asked.confirmation });
  });
});

describe("writing takes two calls", () => {
  const write = { unit: "engine", request: "3B 99 00 02", read: "21 99" } as const;

  it("saves the current value, then writes it once through the guard and reads it back", async () => {
    const { host } = await connected();
    const asked = await host.client.write.request(write);
    expect(asked.lines.join("\n")).toContain("current value: 0001");
    expect(asked.lines.join("\n")).toContain("new value: 0002");
    expect(asked.snapshot).not.toBeNull();
    const saved = await host.client.reports.get({ id: asked.snapshot?.id ?? "" });
    expect(saved.report).toMatchObject({ write_request: "3B990002", previous_value: "0001" });

    const outcome = await host.client.write.confirm({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: true, exitStatus: 0 });
    expect(outcome.lines.join("\n")).toContain("the value now matches the request");
  });

  it("writes nothing when cancelled", async () => {
    const { host } = await connected();
    const asked = await host.client.write.request(write);
    const outcome = await host.client.guarded.cancel({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: false, exitStatus: 1 });
    expect(outcome.lines.join("\n")).toContain("nothing written");
  });

  it("refuses at the request, with nothing pending, a request that is not a write", async () => {
    const { host } = await connected();
    await expect(
      host.client.write.request({ unit: "engine", request: "10 03", read: "21 99" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      host.client.write.request({ unit: "engine", request: "3B 99 00 02", read: "21 98" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      host.client.write.request({ unit: "engine", request: "3B 99 zz", read: "21 99" }),
    ).rejects.toBeInstanceOf(Error);
    // Nothing is parked, so the adapter is free.
    await host.client.link.probe();
  });
});

describe("actuating takes two calls", () => {
  const actuation = {
    unit: "engine",
    request: "30 20 07 01",
    stop: "30 20 00",
    durationMs: 100,
  } as const;

  it("starts, holds and always stops only after the confirmation", async () => {
    const { host } = await connected();
    const asked = await host.client.actuate.request(actuation);
    expect(asked.lines.join("\n")).toContain("stop request: 302000");
    const outcome = await host.client.actuate.confirm({ confirmation: asked.confirmation });
    expect(outcome).toMatchObject({ confirmed: true, exitStatus: 0 });
    expect(outcome.lines.join("\n")).toMatch(
      /sending stop request 302000[\s\S]*control handed back/,
    );
  });

  it("refuses a duration over the cap, a non-actuation request and a mismatched stop", async () => {
    const { host } = await connected();
    await expect(
      host.client.actuate.request({ ...actuation, durationMs: 30_001 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      host.client.actuate.request({ ...actuation, request: "10 03" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      host.client.actuate.request({ ...actuation, stop: "30 21 00" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await turn();
    await host.client.link.probe();
  });
});
