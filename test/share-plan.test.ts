import { describe, expect, it } from "vitest";
import {
  FAULT_SIGNALS,
  MAX_DECODED_BYTES,
  MAX_ENCODED_LENGTH,
  PLAN_PHASE_SIGNAL,
  PLAN_SIGNAL,
  canonicalJson,
  decodeShare,
  describePlanVersion,
  encodeShare,
  faultSampleValue,
  parsePlan,
  planDigest,
  planEnvelope,
  planIdentity,
  planOfRun,
  redactEnvelope,
  runShareEnvelope,
  sha256Hex,
  shareContents,
  type PhaseRecord,
  type Plan,
  type Sample,
  type ShareEnvelope,
} from "../src/core/index.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { loadBuiltinPlan } from "../src/plans/index.js";
import { uncheckedFragment } from "./support/hostile-share.js";

const T0 = 1_700_000_000_000;

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** The first phase of the plain plan document, for tests that change one field of it. */
const IDLE_PHASE = {
  id: "idle",
  title: "Idle",
  instruction: "Let the engine idle without touching the pedal.",
  reads: { start: ["stored-codes"], end: ["stored-codes", "freeze-frame"] },
  end: { when: { kind: "elapsed", seconds: 10 }, timeout: 20, onTimeout: "skip" },
};

/** A plain plan document, before parsing. */
function planDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "obd-read-plan",
    version: 1,
    name: "pedal-check",
    title: "Accelerator pedal check",
    description: "Idle, then press the pedal to the floor and release it.",
    safety: "Parked, handbrake on, in neutral or P; nobody in front of the car.",
    revision: 3,
    source: "A test.",
    needs: { values: ["engine-speed", "pedal-d"] },
    phases: [
      IDLE_PHASE,
      {
        id: "press",
        title: "Press the pedal",
        instruction: "Press the pedal to the floor slowly, then release it.",
        end: {
          when: { kind: "value", value: "engine-speed", op: ">", than: 2000 },
          timeout: 60,
          onTimeout: "skip",
        },
      },
    ],
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  return parsePlan(planDocument(overrides), "test plan");
}

async function roundTrip(envelope: ShareEnvelope): Promise<ShareEnvelope> {
  const encoded = await encodeShare(envelope, zlibShareCodec);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const decoded = await decodeShare(encoded.value.fragment, zlibShareCodec);
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value;
}

/** A recorded run of `recorded`: its plan sample, two phases, readings and a code appearing. */
function runSamples(recorded: Plan, readings = 20, signals = 2): Sample[] {
  const runId = "run-1";
  const phase = (record: PhaseRecord): Sample => ({
    runId,
    signal: PLAN_PHASE_SIGNAL,
    unit: "",
    timestamp: record.startedAt,
    value: JSON.stringify(record),
  });
  const samples: Sample[] = [
    { runId, signal: PLAN_SIGNAL, unit: "", timestamp: T0, value: canonicalJson(recorded) },
    {
      runId,
      signal: FAULT_SIGNALS.stored,
      unit: "",
      timestamp: T0,
      value: faultSampleValue([]),
    },
    phase({
      phase: "idle",
      title: "Idle",
      iteration: 1,
      startedAt: T0,
      endedAt: T0 + 10_000,
      outcome: "completed",
      reads: [
        {
          read: "freeze-frame",
          when: "end",
          at: T0 + 10_000,
          result: {
            kind: "freeze-frame",
            units: [{ unit: "7E8", code: "P0420", values: { note: "WDB2110200A000000" } }],
          },
        },
      ],
    }),
    phase({
      phase: "press",
      title: "Press the pedal",
      iteration: 1,
      startedAt: T0 + 10_000,
      endedAt: T0 + 25_000,
      outcome: "completed",
      reads: [],
    }),
    {
      runId,
      signal: FAULT_SIGNALS.stored,
      unit: "",
      timestamp: T0 + 12_000,
      value: faultSampleValue(["P0420"]),
    },
  ];
  for (let signal = 0; signal < signals; signal++) {
    for (let index = 0; index < readings; index++) {
      samples.push({
        runId,
        signal: `signal ${String(signal)}`,
        unit: "rpm",
        timestamp: T0 + index * 100,
        value: 800 + ((index * 37 + signal * 11) % 2400) + 0.25,
      });
    }
  }
  return samples;
}

const RUN = {
  profile: "generic",
  adapter: "simulator",
  startedAt: T0,
  stoppedAt: T0 + 25_000,
  notes: "plan pedal-check: Accelerator pedal check",
};

describe("SHA-256", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex(ascii("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(ascii(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("plan identity", () => {
  it("gives the same digest for the same plan and another for any change", () => {
    expect(planDigest(plan())).toBe(planDigest(plan()));
    expect(planDigest(plan({ revision: 4 }))).not.toBe(planDigest(plan()));
    expect(planIdentity(plan())).toMatchObject({ name: "pedal-check", revision: 3 });
    expect(planIdentity(plan({ revision: undefined })).revision).toBe(1);
    expect(describePlanVersion(planIdentity(plan()))).toMatch(/^revision 3, [0-9a-f]{12}$/);
  });
});

describe("plan links", () => {
  it("round-trips a plan, defaults filled in, and says what it carries", async () => {
    const envelope = planEnvelope(plan(), T0);
    expect(await roundTrip(envelope)).toEqual(envelope);
    expect(redactEnvelope(envelope)).toBe(envelope);
    expect(shareContents(envelope).join(" ")).toMatch(/2 phases/);
  });

  it("round-trips every shipped plan", async () => {
    for (const name of [
      "cold-start-warm-up",
      "drive-cycle-watch",
      "idle-then-rev",
      "misfire-under-load",
    ]) {
      const envelope = planEnvelope(loadBuiltinPlan(name), T0);
      expect(await roundTrip(envelope)).toEqual(envelope);
    }
  });

  it.each([
    [
      "an unknown value name, with the valid names",
      { needs: { values: ["engine-sped"] } },
      /unknown value engine-sped; valid values: /,
    ],
    ["a step that clears codes", { phases: [{ ...IDLE_PHASE, clear: true }] }, /Unrecognized key/],
    [
      "an actuation read",
      { phases: [{ ...IDLE_PHASE, reads: { start: ["actuate"] } }] },
      /phases\.0\.reads\.start\.0/,
    ],
    [
      "an unknown condition kind",
      {
        phases: [
          { id: "x", title: "X", instruction: "X.", end: { when: { kind: "write", data: "3B" } } },
        ],
      },
      /phases\.0\.end\.when/,
    ],
    [
      "a wait whose timeout is too short",
      {
        phases: [
          {
            id: "x",
            title: "X",
            instruction: "X.",
            end: { when: { kind: "elapsed", seconds: 30 }, timeout: 10 },
          },
        ],
      },
      /timeout of 10 s is not longer/,
    ],
    ["a top-level field the schema does not know", { run: "rm -rf" }, /Unrecognized key/],
  ])("refuses a link whose plan has %s, listing every problem", async (_, overrides, pattern) => {
    const fragment = await uncheckedFragment(
      "plan",
      { v: 1, kind: "plan", createdAt: T0, data: { plan: planDocument(overrides) } },
      zlibShareCodec,
    );
    const decoded = await decodeShare(fragment, zlibShareCodec);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe("invalid");
    const problems = decoded.error.code === "invalid" ? (decoded.error.problems ?? []) : [];
    expect(problems.join("; ")).toMatch(pattern);
  });

  it("refuses a field beside the plan and a prototype key", async () => {
    for (const data of [
      { plan: planDocument(), run: true },
      ((): unknown =>
        JSON.parse(`{"plan": ${JSON.stringify(planDocument())}, "__proto__": {"x": 1}}`))(),
    ]) {
      const fragment = await uncheckedFragment(
        "plan",
        { v: 1, kind: "plan", createdAt: T0, data },
        zlibShareCodec,
      );
      expect((await decodeShare(fragment, zlibShareCodec)).ok).toBe(false);
    }
  });

  it("refuses conditions nested past the limit without throwing, however deep", async () => {
    for (const depth of [9, 5000]) {
      let when: unknown = { kind: "samples", count: 1 };
      for (let level = 0; level < depth; level++) when = { kind: "any", of: [when] };
      const overrides = {
        phases: [{ id: "x", title: "X", instruction: "X.", end: { when, timeout: 30 } }],
      };
      const fragment = await uncheckedFragment(
        "plan",
        { v: 1, kind: "plan", createdAt: T0, data: { plan: planDocument(overrides) } },
        zlibShareCodec,
      ).catch(() => undefined);
      // Canonical JSON of the deepest one overflows the stack before it can be packed; its decoder is still tested below with the shallower one.
      if (fragment === undefined) continue;
      const decoded = await decodeShare(fragment, zlibShareCodec);
      expect(decoded.ok).toBe(false);
    }
  });

  it("refuses a plan over the phase limit and a link over the size limits", async () => {
    const phases = Array.from({ length: 101 }, (_, index) => ({
      id: `p${String(index)}`,
      title: "P",
      instruction: "P.",
      end: { when: { kind: "samples", count: 1 }, timeout: 30 },
    }));
    expect(() => parsePlan(planDocument({ phases }), "big")).toThrow(/phases/);
    const huge = plan({ description: "x".repeat(MAX_DECODED_BYTES) });
    const encoded = await encodeShare(planEnvelope(huge, T0), zlibShareCodec);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error.code).toBe("too-large");
    expect(
      (await decodeShare(`share=2.${"A".repeat(MAX_ENCODED_LENGTH)}`, zlibShareCodec)).ok,
    ).toBe(false);
  });
});

describe("plan result links", () => {
  it("shares a recorded plan run with its whole plan, phases, reads and code changes", async () => {
    const recorded = plan();
    const samples = runSamples(recorded);
    expect(planOfRun(samples)?.identity).toEqual(planIdentity(recorded));
    const envelope = runShareEnvelope(RUN, samples, T0 + 30_000);
    expect(envelope.kind).toBe("plan-result");
    if (envelope.kind !== "plan-result") return;
    const { data } = envelope;
    expect(data.plan).toEqual(recorded);
    expect(data.planHash).toBe(planDigest(recorded));
    expect(data.phases.map((pass) => [pass.phase, pass.start, pass.end, pass.outcome])).toEqual([
      ["idle", 0, 10_000, "completed"],
      ["press", 10_000, 25_000, "completed"],
    ]);
    expect(data.codeEvents).toEqual([
      { at: 12_000, list: "stored", code: "P0420", change: "appeared", atStart: false },
    ]);
    // The plan, its phases and the fault lists travel in their own fields, not as signals.
    expect(data.run.signals.map((signal) => signal.signal).sort()).toEqual([
      "signal 0",
      "signal 1",
    ]);
    expect(await roundTrip(envelope)).toEqual(envelope);
  });

  it("removes VIN-shaped text from the freeze frames when redacted", async () => {
    const envelope = runShareEnvelope(RUN, runSamples(plan()), T0);
    expect(shareContents(envelope).join(" ")).toMatch(/included \(1 value\)/);
    const encoded = await encodeShare(envelope, zlibShareCodec, { redactVin: true });
    if (!encoded.ok) throw new Error(encoded.error.message);
    const decoded = await decodeShare(encoded.value.fragment, zlibShareCodec);
    if (!decoded.ok || decoded.value.kind !== "plan-result") throw new Error("not a plan result");
    expect(decoded.value.data.redacted).toBe(true);
    expect(JSON.stringify(decoded.value.data)).not.toContain("WDB2110200A000000");
  });

  it("refuses a result whose digest does not match the plan it carries", async () => {
    const envelope = runShareEnvelope(RUN, runSamples(plan()), T0);
    if (envelope.kind !== "plan-result") throw new Error("not a plan result");
    const tampered = {
      ...envelope,
      data: { ...envelope.data, plan: { ...envelope.data.plan, title: "Something else" } },
    };
    const fragment = await uncheckedFragment("plan-result", tampered, zlibShareCodec);
    const decoded = await decodeShare(fragment, zlibShareCodec);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.message).toMatch(/digest does not match/);
  });

  it("refuses a result whose embedded plan is invalid", async () => {
    const envelope = runShareEnvelope(RUN, runSamples(plan()), T0);
    if (envelope.kind !== "plan-result") throw new Error("not a plan result");
    const hostile = {
      ...envelope,
      data: { ...envelope.data, plan: { ...envelope.data.plan, needs: { values: ["nope"] } } },
    };
    const decoded = await decodeShare(
      await uncheckedFragment("plan-result", hostile, zlibShareCodec),
      zlibShareCodec,
    );
    expect(decoded.ok).toBe(false);
  });

  it("shares a run with no recorded plan as a run summary", () => {
    const samples = runSamples(plan()).filter((sample) => sample.signal !== PLAN_SIGNAL);
    expect(runShareEnvelope(RUN, samples, T0).kind).toBe("run-summary");
  });

  it("keeps a typical result of a shipped plan well within the link limit", async () => {
    // idle-then-rev with each of its passes, eight signals read every 100 ms for several minutes.
    const shipped = loadBuiltinPlan("idle-then-rev");
    const samples = runSamples(shipped, 3000, 8);
    const encoded = await encodeShare(runShareEnvelope(RUN, samples, T0), zlibShareCodec, {
      redactVin: true,
    });
    if (!encoded.ok) throw new Error(encoded.error.message);
    console.info(
      `typical plan-result fragment: ${String(encoded.value.fragment.length)} characters`,
    );
    expect(encoded.value.fragment.length).toBeLessThan(MAX_ENCODED_LENGTH);
  });
});
