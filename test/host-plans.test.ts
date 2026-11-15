import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  PLAN_PHASE_SIGNAL,
  planPhases,
  withPlan,
  type PlanEventData,
} from "../src/core/index.js";
import { builtinPlans } from "../src/plans/index.js";
import { GENERIC_SIMULATOR, eventually, newSimulatedService } from "./support/host-rig.js";

/** A plan file's text with the given phases, over the three values the simulator reports. */
function planText(phases: unknown[]): string {
  return JSON.stringify({
    format: "obd-read-plan",
    version: 1,
    name: "host-test",
    title: "Host test",
    description: "A plan for the service tests.",
    source: "A test.",
    needs: { values: ["engine-speed", "coolant-temperature", "vehicle-speed"] },
    phases,
  });
}

const TIMED = {
  id: "idle",
  title: "Idle",
  instruction: "Let it idle.",
  reads: { end: ["stored-codes"] },
  end: { when: { kind: "elapsed", seconds: 5 }, timeout: 30 },
};

const CONFIRMED = {
  id: "ready",
  title: "Ready",
  instruction: "Say when.",
  end: { when: { kind: "confirm", prompt: "Ready?" }, timeout: 3000 },
};

async function connected() {
  const service = newSimulatedService();
  await service.host.client.link.connect({ adapter: GENERIC_SIMULATOR });
  return service;
}

async function collect(stream: AsyncIterable<PlanEventData>): Promise<PlanEventData[]> {
  const events: PlanEventData[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("recording plans through the service", () => {
  it("lists the shipped plans with their descriptions and phases", async () => {
    const { host } = newSimulatedService();
    const plans = await host.client.plans.list();
    expect(plans.map((plan) => plan.name)).toEqual(builtinPlans());
    expect(plans.every((plan) => plan.description.length > 0 && plan.phases.length > 0)).toBe(true);
  });

  it("refuses a plan with no connection, an unknown name and an invalid file", async () => {
    const { host } = newSimulatedService();
    await expect(
      host.client.plans.start({ plan: { kind: "file", text: planText([TIMED]), name: "a.json" } }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      host.client.plans.start({ plan: { kind: "shipped", name: "no-such-plan" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /shipped plans: / });
    const misspelt = planText([
      { ...TIMED, end: { when: { kind: "value", value: "engine-sped", op: ">", than: 1 } } },
    ]);
    await expect(
      host.client.plans.start({ plan: { kind: "file", text: misspelt, name: "bad.json" } }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: /unknown value engine-sped; valid values: .*engine-speed/,
    });
    expect(await host.client.runs.list({})).toEqual([]);
  });

  it("runs a plan, streams its events, waits for the confirmation and stores a stopped run", async () => {
    const { host, storage } = await connected();
    const status = await host.client.plans.start({
      plan: { kind: "file", text: planText([TIMED, CONFIRMED]), name: "two.json" },
    });
    expect(status).toMatchObject({ state: "running", plan: { name: "host-test" } });
    const events = collect(await host.client.plans.events({ runId: status.runId }));
    await eventually(async () =>
      (await host.client.plans.status({ runId: status.runId }))?.awaitingConfirm === true
        ? true
        : undefined,
    );
    // Other work on the adapter waits for the plan.
    await expect(
      host.client.plans.start({ plan: { kind: "shipped", name: "idle-then-rev" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(host.client.runs.start({ adapter: GENERIC_SIMULATOR })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(host.client.captures.start({})).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(host.client.link.disconnect()).rejects.toMatchObject({ code: "CONFLICT" });

    await host.client.plans.confirm({ runId: status.runId });
    const seen = await events;
    const types = seen.map((event) => event.type);
    expect(types[0]).toBe("plan-started");
    expect(types).toContain("confirm-requested");
    expect(types.at(-1)).toBe("finished");
    expect(seen.at(-1)).toMatchObject({ outcome: "completed" });
    const read = seen.find((event) => event.type === "read");
    expect(read).toMatchObject({ record: { read: "stored-codes", result: { kind: "codes" } } });
    const sample = seen.find((event) => event.type === "sample");
    expect(sample?.type === "sample" && sample.readings.map((reading) => reading.name)).toEqual([
      "engine-speed",
      "coolant-temperature",
      "vehicle-speed",
    ]);

    expect(await host.client.plans.status({ runId: status.runId })).toMatchObject({
      state: "completed",
      awaitingConfirm: false,
      reason: null,
    });
    const run = await host.client.runs.get({ runId: status.runId });
    expect(run.stoppedAt).not.toBeNull();
    expect(run.notes).toBe("plan host-test: Host test");
    const phases = planPhases(await storage.readSamples({ runId: run.id }));
    expect(phases.map((phase) => [phase.phase, phase.outcome])).toEqual([
      ["idle", "completed"],
      ["ready", "completed"],
    ]);
    // A subscriber after the end sees the whole story and the stream ends.
    const replay = await collect(await host.client.plans.events({ runId: run.id }));
    expect(replay.map((event) => event.type).filter((type) => type === "phase-finished")).toEqual([
      "phase-finished",
      "phase-finished",
    ]);
    // The adapter is free again.
    expect(await host.client.link.disconnect()).toEqual({ disconnected: true });
  });

  it("skips a phase and aborts a plan, keeping the run", async () => {
    const { host, storage } = await connected();
    const waiting = { ...CONFIRMED, id: "first" };
    const status = await host.client.plans.start({
      plan: {
        kind: "file",
        text: planText([waiting, { ...CONFIRMED, id: "second" }]),
        name: "skip.json",
      },
    });
    const awaiting = async (phase: number) => {
      await eventually(async () => {
        const now = await host.client.plans.status({ runId: status.runId });
        return now?.phase === phase && now.awaitingConfirm ? true : undefined;
      });
    };
    await awaiting(0);
    await host.client.plans.skip({ runId: status.runId });
    await awaiting(1);
    await host.client.plans.abort({ runId: status.runId });
    await eventually(async () =>
      (await host.client.plans.status({ runId: status.runId }))?.state === "aborted"
        ? true
        : undefined,
    );
    const samples = await storage.readSamples({ runId: status.runId, signal: PLAN_PHASE_SIGNAL });
    expect(planPhases(samples).map((phase) => [phase.phase, phase.outcome])).toEqual([
      ["first", "skipped"],
      ["second", "aborted"],
    ]);
    expect((await host.client.runs.get({ runId: status.runId })).stoppedAt).not.toBeNull();
    await expect(host.client.plans.confirm({ runId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("stops a plan's run left open by a reload instead of resuming it", async () => {
    const storage = new MemoryStorage();
    // A page recorded a plan and was reloaded mid-phase: its run is stored, open, with a reading.
    const run = await storage.createRun({
      profile: "generic-obd2",
      adapter: GENERIC_SIMULATOR,
      startedAt: 1_700_000_000_000,
      notes: withPlan("plan idle-then-rev: Idle, hold revs, idle, blips", "idle-then-rev"),
    });
    await storage.appendSamples([
      {
        runId: run.id,
        signal: "engine speed",
        unit: "rpm",
        timestamp: run.startedAt + 4000,
        value: 800,
      },
    ]);
    const { host } = newSimulatedService({ storage });
    expect(await host.client.plans.status({ runId: run.id })).toBeNull();
    await expect(host.client.runs.resume({ runId: run.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: /plan idle-then-rev, and a plan does not resume/,
    });
    // A run another page names as its own is left alone.
    expect(await host.client.plans.recover({ runIds: [] })).toEqual([]);
    const recovered = await host.client.plans.recover({ runIds: [run.id, "unknown"] });
    expect(recovered).toEqual([
      expect.objectContaining({
        id: run.id,
        stoppedAt: run.startedAt + 4000,
        notes: "plan idle-then-rev: Idle, hold revs, idle, blips",
      }),
    ]);
    expect(await host.client.plans.recover({ runIds: [run.id] })).toEqual([]);
  });
});
