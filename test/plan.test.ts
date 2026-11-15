import { describe, expect, it } from "vitest";
import {
  ConditionTracker,
  DEFAULT_WAIT_TIMEOUT_S,
  PLAN_VALUE_NAMES,
  PlanError,
  describeCondition,
  parsePlan,
  parsePlanText,
  type PlanCondition,
} from "../src/core/index.js";
import { builtinPlanData, builtinPlans, loadBuiltinPlan } from "../src/plans/index.js";

/** A minimal valid plan document, changed by `edit`. */
function document(edit: (plan: Record<string, unknown>) => void = () => undefined): unknown {
  const plan: Record<string, unknown> = {
    format: "obd-read-plan",
    version: 1,
    name: "example",
    title: "Example",
    description: "An example.",
    source: "A test.",
    needs: { values: ["engine-speed", "coolant-temperature"] },
    phases: [
      {
        id: "idle",
        title: "Idle",
        instruction: "Let it idle.",
        end: { when: { kind: "elapsed", seconds: 10 } },
      },
    ],
  };
  edit(plan);
  return plan;
}

function phase(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "p",
    title: "P",
    instruction: "Do it.",
    end: { when: { kind: "elapsed", seconds: 10 } },
    ...extra,
  };
}

function problems(data: unknown): string {
  try {
    parsePlan(data, "test");
  } catch (error) {
    if (error instanceof PlanError) return error.message;
    throw error;
  }
  throw new Error("the plan was accepted");
}

describe("the plan schema", () => {
  it("accepts every shipped plan", () => {
    expect(builtinPlans()).toEqual([
      "cold-start-warm-up",
      "drive-cycle-watch",
      "idle-then-rev",
      "misfire-under-load",
    ]);
    for (const name of builtinPlans()) {
      const plan = loadBuiltinPlan(name);
      expect(plan.name).toBe(name);
    }
  });

  it("says plainly in every shipped plan that the person does the driving or the pedal work, and where", () => {
    for (const name of builtinPlans()) {
      const plan = loadBuiltinPlan(name);
      expect(plan.description).toMatch(/person/);
      for (const step of plan.phases) {
        if (
          step.instruction.includes("pedal") &&
          !step.instruction.includes("without touching the pedal")
        ) {
          expect(step.instruction, `${name} ${step.id}`).toMatch(/[Pp]arked/);
          expect(step.instruction, `${name} ${step.id}`).toMatch(/handbrake on/);
          expect(step.instruction, `${name} ${step.id}`).toMatch(/neutral/);
        }
      }
    }
  });

  it("fills in the defaults: the wait timeout, failing on timeout, one-second sampling and no reads", () => {
    const plan = parsePlan(document(), "test");
    const [only] = plan.phases;
    expect(only?.end.timeout).toBe(DEFAULT_WAIT_TIMEOUT_S);
    expect(only?.end.onTimeout).toBe("fail");
    expect(only?.sample.every).toBe(1);
    expect(only?.reads).toEqual({ start: [], end: [] });
    expect(only?.watchCodes).toBe(false);
  });

  it("rejects an unknown value name wherever a plan names one, listing the valid names", () => {
    const valid = `valid values: ${PLAN_VALUE_NAMES.join(", ")}`;
    const cases: [string, unknown][] = [
      [
        "needs.values",
        document((plan) => {
          plan.needs = { values: ["engine-sped"] };
        }),
      ],
      [
        "phases.0.sample.values",
        document((plan) => {
          plan.needs = { values: "all" };
          plan.phases = [phase({ sample: { values: ["rpm"] } })];
        }),
      ],
      [
        "phases.0.end.when",
        document((plan) => {
          plan.phases = [
            phase({ end: { when: { kind: "value", value: "speed", op: ">", than: 1 } } }),
          ];
        }),
      ],
      [
        "phases.0.start.when",
        document((plan) => {
          plan.phases = [
            phase({
              start: {
                when: {
                  kind: "any",
                  of: [{ kind: "value", value: "revs", op: "stable", within: 1, for: 5 }],
                },
              },
            }),
          ];
        }),
      ],
      [
        "phases.0.repeat.until",
        document((plan) => {
          plan.phases = [
            phase({
              repeat: { until: { kind: "value", value: "temp", op: "<", than: 1 }, max: 3 },
            }),
          ];
        }),
      ],
    ];
    for (const [path, data] of cases) {
      const message = problems(data);
      expect(message, path).toContain(`${path}: unknown value`);
      expect(message, path).toContain(valid);
    }
  });

  it("rejects a condition on a value the phase does not sample", () => {
    expect(
      problems(
        document((plan) => {
          plan.phases = [
            phase({
              sample: { values: ["coolant-temperature"] },
              end: { when: { kind: "value", value: "engine-speed", op: ">", than: 1 } },
            }),
          ];
        }),
      ),
    ).toContain("tests values the phase does not sample: engine-speed");
  });

  it("rejects sampling a value the plan does not need", () => {
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({ sample: { values: ["vehicle-speed"] } })];
        }),
      ),
    ).toContain("not in needs.values: vehicle-speed");
  });

  it("rejects a timeout no longer than the condition needs, so a wait cannot be certain to time out", () => {
    expect(
      problems(
        document((plan) => {
          plan.phases = [
            phase({
              end: {
                when: {
                  kind: "all",
                  of: [
                    { kind: "elapsed", seconds: 5 },
                    {
                      kind: "value",
                      value: "engine-speed",
                      op: "between",
                      min: 1,
                      max: 2,
                      for: 60,
                    },
                  ],
                },
                timeout: 60,
              },
            }),
          ];
        }),
      ),
    ).toContain("the timeout of 60 s is not longer than the 60 s the condition needs");
  });

  it("rejects a repeat that waits for the person, a repeat beyond the maximum, duplicate ids and a multi-line instruction", () => {
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({ repeat: { until: { kind: "confirm" }, max: 2 } })];
        }),
      ),
    ).toContain("a repeat cannot wait for the person to confirm");
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({ repeat: { times: 1000 } })];
        }),
      ),
    ).toContain("phases.0.repeat");
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({}), phase({})];
        }),
      ),
    ).toContain("phase id p is used twice");
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({ instruction: "one\ntwo" })];
        }),
      ),
    ).toContain("a single line of text");
  });

  it("rejects a condition kind it does not know, a field it does not know and code to evaluate", () => {
    expect(
      problems(
        document((plan) => {
          plan.phases = [phase({ end: { when: { kind: "script", source: "return true" } } })];
        }),
      ),
    ).toContain("phases.0.end.when");
    expect(
      problems(
        document((plan) => {
          plan.phases = [
            phase({ end: { when: { kind: "elapsed", seconds: 1, eval: "1" }, timeout: 5 } }),
          ];
        }),
      ),
    ).toContain("eval");
    expect(
      problems(
        document((plan) => {
          plan.phases = [
            phase({ end: { when: { kind: "elapsed", seconds: 1 }, onTimeout: "wait" } }),
          ];
        }),
      ),
    ).toContain("onTimeout");
  });

  it("rejects text that is not JSON and names the document", () => {
    expect(() => parsePlanText("{", "broken.obdplan.json")).toThrow(
      /^broken\.obdplan\.json: invalid plan/,
    );
  });

  it("names the shipped plans when asked for one that does not exist", () => {
    expect(() => builtinPlanData("nope")).toThrow(
      "'nope': no such plan: shipped plans: cold-start-warm-up, drive-cycle-watch, idle-then-rev, misfire-under-load",
    );
  });
});

function sample(at: number, values: Record<string, number | string | undefined>) {
  return { type: "sample" as const, at, values: new Map(Object.entries(values)) };
}

function tracker(condition: PlanCondition, baseline = new Map()) {
  return new ConditionTracker(condition, 0, baseline);
}

describe("the condition tracker", () => {
  it("counts elapsed time and samples from the start of the wait", () => {
    const elapsed = tracker({ kind: "elapsed", seconds: 10 });
    expect(elapsed.status(9_999).met).toBe(false);
    expect(elapsed.status(10_000)).toEqual({ met: true, progress: "10 of 10 s" });
    const samples = tracker({ kind: "samples", count: 2 });
    samples.observe(sample(1, {}));
    expect(samples.status(1).met).toBe(false);
    samples.observe(sample(2, {}));
    expect(samples.status(2)).toEqual({ met: true, progress: "2 of 2 samples" });
  });

  it("holds a comparison at once, or only after every sample for the given seconds", () => {
    const now = tracker({ kind: "value", value: "engine-speed", op: ">=", than: 2000 });
    now.observe(sample(0, { "engine-speed": 1999 }));
    expect(now.status(0).met).toBe(false);
    now.observe(sample(1000, { "engine-speed": 2000 }));
    expect(now.status(1000).met).toBe(true);

    const held = tracker({
      kind: "value",
      value: "engine-speed",
      op: "between",
      min: 2000,
      max: 2500,
      for: 3,
    });
    for (const [at, rpm] of [
      [0, 2100],
      [1000, 2200],
      [2000, 2600],
      [3000, 2300],
      [4000, 2300],
      [5000, 2300],
    ] as const) {
      held.observe(sample(at, { "engine-speed": rpm }));
      if (at === 2000)
        expect(held.status(at).progress).toBe(
          "engine-speed 2600, waiting for engine-speed between 2000 and 2500 for 3 s",
        );
    }
    expect(held.status(5000).met).toBe(false);
    held.observe(sample(6000, { "engine-speed": 2400 }));
    expect(held.status(6000)).toEqual({ met: true, progress: "engine-speed 2400, held 3 of 3 s" });
  });

  it("breaks a held comparison on a value that was not read", () => {
    const held = tracker({ kind: "value", value: "engine-speed", op: "<", than: 1000, for: 1 });
    held.observe(sample(0, { "engine-speed": 800 }));
    held.observe(sample(500, { "engine-speed": undefined }));
    held.observe(sample(1000, { "engine-speed": 800 }));
    expect(held.status(1000).met).toBe(false);
  });

  it("finds a value stable once its spread stays within the tolerance for the given seconds", () => {
    const stable = tracker({
      kind: "value",
      value: "coolant-temperature",
      op: "stable",
      within: 2,
      for: 3,
    });
    const temperatures = [40, 60, 80, 85, 86, 85, 86];
    temperatures.forEach((value, index) => {
      stable.observe(sample(index * 1000, { "coolant-temperature": value }));
    });
    expect(stable.status(6000)).toEqual({
      met: true,
      progress: "coolant-temperature 86, steady 3 of 3 s",
    });
    stable.observe(sample(7000, { "coolant-temperature": 95 }));
    expect(stable.status(7000).met).toBe(false);
  });

  it("sees a code appear that was not in its list when the wait began, and stays met", () => {
    const appears = tracker(
      { kind: "code-appears", list: "pending" },
      new Map([["pending", ["P0420"]]]),
    );
    appears.observe({ type: "codes", at: 1, list: "pending", codes: ["P0420"] });
    expect(appears.status(1).met).toBe(false);
    appears.observe({ type: "codes", at: 2, list: "stored", codes: ["P0300"] });
    expect(appears.status(2).met).toBe(false);
    appears.observe({ type: "codes", at: 3, list: "pending", codes: ["P0300", "P0420"] });
    appears.observe({ type: "codes", at: 4, list: "pending", codes: [] });
    expect(appears.status(4)).toEqual({ met: true, progress: "P0300 appeared" });

    const named = tracker({ kind: "code-appears", code: "P0301" });
    named.observe({ type: "codes", at: 1, list: "stored", codes: [] });
    named.observe({ type: "codes", at: 2, list: "stored", codes: ["P0300"] });
    expect(named.status(2).met).toBe(false);
  });

  it("sees a code clear that was present at the start or seen since", () => {
    const clears = tracker({ kind: "code-clears" }, new Map([["stored", ["P0420"]]]));
    clears.observe({ type: "codes", at: 1, list: "stored", codes: ["P0420"] });
    expect(clears.status(1).met).toBe(false);
    clears.observe({ type: "codes", at: 2, list: "stored", codes: [] });
    expect(clears.status(2)).toEqual({ met: true, progress: "P0420 cleared" });

    const later = tracker({ kind: "code-clears", code: "P0300", list: "pending" });
    later.observe({ type: "codes", at: 1, list: "pending", codes: [] });
    expect(later.status(1).met).toBe(false);
    later.observe({ type: "codes", at: 2, list: "pending", codes: ["P0300"] });
    later.observe({ type: "codes", at: 3, list: "pending", codes: [] });
    expect(later.status(3).met).toBe(true);
  });

  it("waits for the person's confirmation, and combines conditions with any and all", () => {
    const confirm = tracker({ kind: "confirm", prompt: "Ready?" });
    expect(confirm.status(0)).toEqual({ met: false, progress: "waiting for Ready?" });
    confirm.observe({ type: "confirmed", at: 1 });
    expect(confirm.status(1).met).toBe(true);

    const condition: PlanCondition = {
      kind: "any",
      of: [
        { kind: "elapsed", seconds: 60 },
        {
          kind: "all",
          of: [
            { kind: "samples", count: 1 },
            { kind: "value", value: "vehicle-speed", op: "<", than: 1 },
          ],
        },
      ],
    };
    expect(describeCondition(condition)).toBe("60 s or 1 samples and vehicle-speed < 1");
    const either = tracker(condition);
    either.observe(sample(1000, { "vehicle-speed": 30 }));
    expect(either.status(1000).met).toBe(false);
    either.observe(sample(2000, { "vehicle-speed": 0 }));
    expect(either.status(2000).met).toBe(true);
    expect(tracker(condition).status(60_000).met).toBe(true);
  });
});
