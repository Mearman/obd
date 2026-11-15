import { describe, expect, it } from "vitest";
import {
  FAULT_SIGNALS,
  DiagProtocol,
  Elm,
  FUNCTIONAL_REQUEST_ID,
  FakeElmCore,
  MemoryStorage,
  PLAN_PHASE_SIGNAL,
  PlanRunner,
  adapterTransport,
  faultEvents,
  parsePlan,
  planPhases,
  simulatedLiveCar,
  type PlanClock,
  type PlanEvent,
  type PlanLink,
} from "../src/core/index.js";
import { loadBuiltinPlan } from "../src/plans/index.js";

/** A clock that only moves when the runner sleeps, so a plan of minutes runs at once. */
class FakeClock implements PlanClock {
  constructor(public time = 1_700_000_000_000) {}

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number): Promise<void> {
    // A fastest phase sleeps for nothing; a millisecond keeps the fake time moving.
    this.time += Math.max(1, milliseconds);
    return Promise.resolve();
  }
}

/** What the scripted engine unit reports, as functions of the seconds since the clock's start. */
interface Script {
  rpm?: (seconds: number) => number;
  coolant?: (seconds: number) => number;
  speed?: (seconds: number) => number;
  stored?: (seconds: number) => readonly string[];
  pending?: (seconds: number) => readonly string[];
}

function codeBytes(code: string): number[] {
  const letter = "PCBU".indexOf(code.charAt(0));
  const digits = Number.parseInt(code.slice(1), 16);
  return [(letter << 6) | (digits >> 8), digits & 0xff];
}

function codesReply(mode: number, found: readonly string[]): Uint8Array {
  return Uint8Array.of(mode + 0x40, found.length, ...found.flatMap(codeBytes));
}

/** An engine unit at the functional address that answers from `script` at the clock's time. */
function scriptedCar(clock: FakeClock, script: Script): FakeElmCore {
  const start = clock.time;
  const seconds = (): number => (clock.time - start) / 1000;
  return new FakeElmCore({
    [FUNCTIONAL_REQUEST_ID]: (request) => {
      const key = [...request]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      const reply = (...bytes: number[]): [number, Uint8Array][] => [
        [0x7e8, Uint8Array.from(bytes)],
      ];
      switch (key) {
        case "0100":
          // Coolant temperature (05), engine speed (0C) and vehicle speed (0D).
          return reply(0x41, 0x00, 0x08, 0x18, 0x00, 0x00);
        case "0105":
          return reply(0x41, 0x05, Math.round((script.coolant?.(seconds()) ?? 20) + 40));
        case "010C": {
          const quarter = Math.round((script.rpm?.(seconds()) ?? 800) * 4);
          return reply(0x41, 0x0c, quarter >> 8, quarter & 0xff);
        }
        case "010D":
          return reply(0x41, 0x0d, Math.round(script.speed?.(seconds()) ?? 0));
        case "03":
          return [[0x7e8, codesReply(0x03, script.stored?.(seconds()) ?? [])]];
        case "07":
          return [[0x7e8, codesReply(0x07, script.pending?.(seconds()) ?? [])]];
        case "0A":
          return [[0x7e8, codesReply(0x0a, [])]];
        default:
          return [];
      }
    },
  });
}

async function linkTo(car: FakeElmCore): Promise<{ link: PlanLink; elm: Elm }> {
  const transport = adapterTransport(car);
  await transport.open();
  const elm = new Elm(transport);
  await elm.initialise();
  return { elm, link: { withSession: (work) => work({ elm }) } };
}

function planOf(
  phases: unknown[],
  values: unknown = ["engine-speed", "coolant-temperature", "vehicle-speed"],
) {
  return parsePlan(
    {
      format: "obd-read-plan",
      version: 1,
      name: "test-plan",
      title: "Test plan",
      description: "A test.",
      source: "A test.",
      needs: { values },
      phases,
    },
    "test",
  );
}

async function runPlan(
  plan: ReturnType<typeof planOf>,
  script: Script,
  onEvent: (event: PlanEvent, runner: PlanRunner) => void = () => undefined,
) {
  const clock = new FakeClock();
  const { link } = await linkTo(scriptedCar(clock, script));
  const storage = new MemoryStorage();
  const events: PlanEvent[] = [];
  const runner: PlanRunner = new PlanRunner({
    plan,
    link,
    storage,
    adapter: "tcp://fake:1",
    clock,
    codesIntervalMs: 5000,
    onEvent: (event) => {
      events.push(event);
      onEvent(event, runner);
    },
  });
  const result = await runner.run();
  const samples = await storage.readSamples({ runId: result.runId });
  const run = await storage.getRun(result.runId);
  return { result, events, samples, run, clock };
}

const IDLE_THEN_REV: Script = {
  // Idles to 70 s, holds 2200 rpm to 150 s, idles, then blips at 200, 210 and 220 s.
  rpm: (t) =>
    t >= 70 && t < 150
      ? 2200
      : [200, 210, 220].some((blip) => t >= blip && t < blip + 1)
        ? 3200
        : 800,
};

/** The most a whole shipped plan may take to run on the simulator in a test, in milliseconds: a bound for a heavily loaded machine, not an expectation. */
const PLAN_RUN_BUDGET_MS = 30_000;

describe("the plan runner", () => {
  it(
    "runs the shipped idle-then-rev plan through every phase and stores it as one run",
    async () => {
      const { result, events, samples, run } = await runPlan(
        loadBuiltinPlan("idle-then-rev"),
        IDLE_THEN_REV,
      );
      expect(result.outcome).toBe("completed");
      expect(
        result.phases.map((phase) => `${phase.phase}#${String(phase.iteration)} ${phase.outcome}`),
      ).toEqual([
        "idle#1 completed",
        "hold#1 completed",
        "idle-again#1 completed",
        "blip#1 completed",
        "blip#2 completed",
        "blip#3 completed",
      ]);
      expect(run?.stoppedAt).not.toBeNull();
      expect(run?.notes).toBe("plan idle-then-rev: Idle, hold revs, idle, blips");
      expect(run?.profile).toBe("generic-obd2");
      // One stored record per pass, read back from the run's own samples.
      expect(planPhases(samples)).toEqual(result.phases);
      const hold = result.phases[1];
      expect(hold === undefined ? 0 : hold.endedAt - hold.startedAt).toBeGreaterThanOrEqual(60_000);
      expect(hold?.reads.map((read) => read.read)).toEqual(["stored-codes", "pending-codes"]);
      expect(samples.filter((sample) => sample.signal === "engine speed").length).toBeGreaterThan(
        150,
      );
      const instructions = events.flatMap((event) =>
        event.type === "phase-started" ? [event.phase.instruction] : [],
      );
      expect(instructions[1]).toMatch(/^Still parked, handbrake on, in neutral or P/);
      // The plan is six phases and well over 150 simulated request round trips, so the budget is that work with a generous margin for a loaded machine, not vitest's default 5 s.
    },
    PLAN_RUN_BUDGET_MS,
  );

  it("skips a phase whose wait times out with skip, after its end reads, and carries on", async () => {
    const plan = planOf([
      {
        id: "never",
        title: "Never",
        instruction: "Wait.",
        reads: { end: ["stored-codes"] },
        end: {
          when: { kind: "value", value: "engine-speed", op: ">", than: 5000 },
          timeout: 10,
          onTimeout: "skip",
        },
      },
      {
        id: "after",
        title: "After",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 2 } },
      },
    ]);
    const { result, events } = await runPlan(plan, {});
    expect(result.outcome).toBe("completed");
    expect(result.phases.map((phase) => phase.outcome)).toEqual(["timed-out", "completed"]);
    expect(result.phases[0]?.reads).toHaveLength(1);
    expect(
      events.some((event) => event.type === "condition-timed-out" && event.onTimeout === "skip"),
    ).toBe(true);
  });

  it("ends the plan as failed when a wait with fail times out, and still stops the run", async () => {
    const plan = planOf([
      {
        id: "start",
        title: "Start",
        instruction: "Start the engine.",
        start: {
          when: { kind: "value", value: "engine-speed", op: ">", than: 5000 },
          timeout: 10,
          onTimeout: "fail",
        },
        end: { when: { kind: "elapsed", seconds: 1 } },
      },
      {
        id: "after",
        title: "After",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 2 } },
      },
    ]);
    const { result, run } = await runPlan(plan, {});
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "phase start timed out waiting to start",
    });
    expect(result.phases.map((phase) => phase.outcome)).toEqual(["timed-out"]);
    expect(run?.stoppedAt).not.toBeNull();
  });

  it("repeats a phase a fixed number of times, or until a condition holds at the end of a pass", async () => {
    const times = planOf([
      {
        id: "pass",
        title: "Pass",
        instruction: "Wait.",
        repeat: { times: 3 },
        end: { when: { kind: "samples", count: 2 } },
      },
    ]);
    expect((await runPlan(times, {})).result.phases.map((phase) => phase.iteration)).toEqual([
      1, 2, 3,
    ]);
    const until = planOf([
      {
        id: "warm",
        title: "Warm",
        instruction: "Wait.",
        repeat: {
          until: { kind: "value", value: "coolant-temperature", op: ">=", than: 80 },
          max: 10,
        },
        end: { when: { kind: "elapsed", seconds: 10 } },
      },
    ]);
    // Coolant rises a degree a second from 50 °C, so it reaches 80 °C at the end of the third ten-second pass.
    const warmed = await runPlan(until, { coolant: (t) => 50 + t });
    expect(warmed.result.phases.map((phase) => phase.iteration)).toEqual([1, 2, 3]);
  });

  it("stops at the maximum when a repeat's condition never holds", async () => {
    const plan = planOf([
      {
        id: "warm",
        title: "Warm",
        instruction: "Wait.",
        repeat: {
          until: { kind: "value", value: "coolant-temperature", op: ">=", than: 200 },
          max: 2,
        },
        end: { when: { kind: "elapsed", seconds: 1 } },
      },
    ]);
    expect((await runPlan(plan, {})).result.phases).toHaveLength(2);
  });

  it("aborts at the next step, records the phase as aborted and stops the run", async () => {
    const plan = planOf([
      {
        id: "long",
        title: "Long",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 600 }, timeout: 900 },
      },
      {
        id: "after",
        title: "After",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 2 } },
      },
    ]);
    let count = 0;
    const { result, run, samples } = await runPlan(plan, {}, (event, runner) => {
      if (event.type === "sample" && ++count === 5) runner.abort();
    });
    expect(result).toMatchObject({ outcome: "aborted", reason: "aborted" });
    expect(result.phases.map((phase) => phase.outcome)).toEqual(["aborted"]);
    expect(run?.stoppedAt).not.toBeNull();
    expect(planPhases(samples)).toHaveLength(1);
  });

  it("skips the current phase on request and goes on to the next", async () => {
    const plan = planOf([
      {
        id: "long",
        title: "Long",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 600 }, timeout: 900 },
      },
      {
        id: "after",
        title: "After",
        instruction: "Wait.",
        end: { when: { kind: "elapsed", seconds: 2 } },
      },
    ]);
    let count = 0;
    const { result } = await runPlan(plan, {}, (event, runner) => {
      if (event.type === "sample" && ++count === 3) runner.skipPhase();
    });
    expect(result.outcome).toBe("completed");
    expect(result.phases.map((phase) => phase.outcome)).toEqual(["skipped", "completed"]);
  });

  it("asks for confirmation and waits for it, then counts it; a confirmation nobody asked for is ignored", async () => {
    const plan = planOf([
      {
        id: "ready",
        title: "Ready",
        instruction: "Get ready.",
        end: { when: { kind: "confirm", prompt: "Ready?" }, timeout: 60 },
      },
    ]);
    let samplesBefore = 0;
    const { result, events } = await runPlan(plan, {}, (event, runner) => {
      if (event.type === "plan-started") runner.confirm();
      if (event.type === "sample" && ++samplesBefore === 4) runner.confirm();
    });
    expect(result.outcome).toBe("completed");
    expect(events.find((event) => event.type === "confirm-requested")).toMatchObject({
      prompt: "Ready?",
      stage: "end",
    });
    expect(samplesBefore).toBe(4);
    const unanswered = await runPlan(plan, {});
    expect(unanswered.result).toMatchObject({
      outcome: "failed",
      reason: "phase ready timed out waiting for Ready?",
    });
  });

  it("reports and stores each code that appears or clears while a phase watches the code lists", async () => {
    const plan = planOf([
      {
        id: "drive",
        title: "Drive",
        instruction: "Drive.",
        watchCodes: true,
        end: { when: { kind: "elapsed", seconds: 60 }, timeout: 120 },
      },
    ]);
    const { result, events, samples } = await runPlan(plan, {
      stored: (t) => (t < 30 ? ["P0420"] : []),
      pending: (t) => (t >= 20 ? ["P0300"] : []),
    });
    expect(result.outcome).toBe("completed");
    const changes = events.flatMap((event) =>
      event.type === "code-appeared" || event.type === "code-cleared"
        ? [`${event.type} ${event.list} ${event.code}`]
        : [],
    );
    expect(changes).toEqual(["code-appeared pending P0300", "code-cleared stored P0420"]);
    const stored = samples
      .filter((sample) => sample.signal === FAULT_SIGNALS.stored)
      .map((sample) => sample.value);
    expect(stored).toEqual(["P0420", "none"]);
    const pending = samples
      .filter((sample) => sample.signal === FAULT_SIGNALS.pending)
      .map((sample) => sample.value);
    expect(pending).toEqual(["none", "P0300"]);
    // The collection runs' reader finds the same changes in the plan's samples.
    expect(
      faultEvents(samples)
        .filter((event) => !event.atStart)
        .map((event) => `${event.change} ${event.list} ${event.code}`),
    ).toEqual(["appeared pending P0300", "disappeared stored P0420"]);
  });

  it("ends a phase when a code appears, comparing against the lists when the wait began", async () => {
    const plan = planOf([
      {
        id: "watch",
        title: "Watch",
        instruction: "Drive.",
        end: { when: { kind: "code-appears", list: "pending" }, timeout: 300 },
      },
    ]);
    const { result, events } = await runPlan(plan, {
      pending: (t) => (t >= 40 ? ["P0300", "P0420"] : ["P0420"]),
    });
    expect(result.outcome).toBe("completed");
    const met = events.find((event) => event.type === "condition-met");
    const started = events.find((event) => event.type === "plan-started");
    expect(
      met === undefined || started === undefined ? 0 : met.at - started.at,
    ).toBeGreaterThanOrEqual(40_000);
  });

  it("refuses, before creating a run, a plan that waits on a value the car does not report", async () => {
    const plan = planOf(
      [
        {
          id: "load",
          title: "Load",
          instruction: "Wait.",
          end: { when: { kind: "value", value: "engine-load", op: ">", than: 50 } },
        },
      ],
      "all",
    );
    const clock = new FakeClock();
    const { link } = await linkTo(scriptedCar(clock, {}));
    const storage = new MemoryStorage();
    await expect(
      new PlanRunner({ plan, link, storage, adapter: "x", clock }).run(),
    ).rejects.toThrow(
      "phase load waits on engine-load, which the car does not report; it reports: coolant-temperature, engine-speed, vehicle-speed",
    );
    expect(await storage.listRuns()).toEqual([]);
  });

  it("runs on the simulator, taking every read through the read-only services", async () => {
    const car = simulatedLiveCar({ protocol: DiagProtocol.KWP2000, units: new Map() });
    const { link } = await linkTo(car);
    const storage = new MemoryStorage();
    const plan = planOf(
      [
        {
          id: "only",
          title: "Only",
          instruction: "Wait.",
          reads: {
            start: ["stored-codes", "freeze-frame", "misfire-counters"],
            end: ["pending-codes", "permanent-codes"],
          },
          end: { when: { kind: "samples", count: 3 } },
        },
      ],
      "all",
    );
    const result = await new PlanRunner({
      plan,
      link,
      storage,
      adapter: "simulator://generic-obd2",
      clock: new FakeClock(),
    }).run();
    expect(result.outcome).toBe("completed");
    const [phase] = result.phases;
    expect(phase?.reads.map((read) => read.result.kind)).toEqual([
      "codes",
      "freeze-frame",
      "misfire-counters",
      "codes",
      "codes",
    ]);
    expect(phase?.reads[0]?.result).toEqual({
      kind: "codes",
      list: "stored",
      units: [{ unit: "7E8", codes: ["P0420"] }],
    });
    expect(phase?.reads[1]?.result).toMatchObject({
      kind: "freeze-frame",
      units: [{ unit: "7E8", code: "P0420" }],
    });
    // Only legislated read services went to the car: current data, freeze frame, codes and monitor results.
    const services = new Set(car.requests.map((line) => line.slice(0, 2)));
    expect([...services].sort()).toEqual(["01", "02", "03", "06", "07", "0A"]);
    const samples = await storage.readSamples({ runId: result.runId });
    expect(samples.filter((sample) => sample.signal === PLAN_PHASE_SIGNAL)).toHaveLength(1);
  });
});
