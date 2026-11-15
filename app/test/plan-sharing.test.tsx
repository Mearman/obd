import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FAULT_SIGNALS,
  MemoryStorage,
  PLAN_PHASE_SIGNAL,
  PLAN_SIGNAL,
  canonicalJson,
  encodeShare,
  faultSampleValue,
  parsePlan,
  planEnvelope,
  runShareEnvelope,
  type Plan,
  type Sample,
  type ShareEnvelope,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import type { DatabaseSession } from "../src/database/session";
import { CONDITION_CHOICES } from "../src/guide/ConditionEditor";
import { keepPlan } from "../src/guide/my-plans";
import { PlanEditor, blankPlan, revised } from "../src/guide/PlanEditor";
import { fakeControl } from "./fake-database";
import { createTestService, renderApp } from "./render";

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

const T0 = 1_700_000_000_000;

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function sessionOver(storage: MemoryStorage): DatabaseSession {
  return {
    connection: Promise.resolve({ storage, control: fakeControl() }),
    subscribe: () => () => undefined,
    busy: () => false,
    subscribeBusy: () => () => undefined,
    close: () => undefined,
  };
}

function pedalPlan(): Plan {
  return parsePlan(
    {
      ...blankPlan(),
      name: "pedal-check",
      title: "Accelerator pedal check",
      revision: 2,
      needs: { values: ["engine-speed", "pedal-d"] },
      phases: [
        {
          id: "idle",
          title: "Idle",
          instruction: "Let the engine idle.",
          end: { when: { kind: "elapsed", seconds: 5 }, timeout: 20, onTimeout: "skip" },
        },
        {
          id: "press",
          title: "Press the pedal",
          instruction: "Press the pedal slowly to the floor, then release it.",
          end: { when: { kind: "elapsed", seconds: 5 }, timeout: 20, onTimeout: "skip" },
        },
      ],
    },
    "test",
  );
}

async function fragmentOf(envelope: ShareEnvelope): Promise<string> {
  const encoded = await encodeShare(envelope, streamShareCodec);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value.fragment;
}

/** A recorded run of `plan`: its plan sample, two phases, a code appearing and two readings a second. */
function recordedSamples(plan: Plan): Sample[] {
  const runId = "r";
  const phase = (id: string, title: string, start: number, end: number): Sample => ({
    runId,
    signal: PLAN_PHASE_SIGNAL,
    unit: "",
    timestamp: T0 + start,
    value: JSON.stringify({
      phase: id,
      title,
      iteration: 1,
      startedAt: T0 + start,
      endedAt: T0 + end,
      outcome: "completed",
      reads: [],
    }),
  });
  const samples: Sample[] = [
    { runId, signal: PLAN_SIGNAL, unit: "", timestamp: T0, value: canonicalJson(plan) },
    { runId, signal: FAULT_SIGNALS.stored, unit: "", timestamp: T0, value: faultSampleValue([]) },
    phase("idle", "Idle", 0, 5000),
    phase("press", "Press the pedal", 5000, 10_000),
    {
      runId,
      signal: FAULT_SIGNALS.stored,
      unit: "",
      timestamp: T0 + 7000,
      value: faultSampleValue(["P2138"]),
    },
  ];
  for (let index = 0; index <= 20; index++) {
    samples.push({
      runId,
      signal: "engine speed",
      unit: "rpm",
      timestamp: T0 + index * 500,
      value: index < 10 ? 800 : 800 + (index - 10) * 300,
    });
  }
  return samples;
}

function renderEditor() {
  const onSave = vi.fn<(plan: Plan) => Promise<void>>(() => Promise.resolve());
  render(<PlanEditor initial={blankPlan()} onSave={onSave} onCancel={() => undefined} />);
  return { onSave };
}

function status(): string {
  return screen.getByRole("status", { name: "Plan version" }).textContent;
}

describe("the plan editor", () => {
  it("builds an end condition of every kind the schema has, each one valid", async () => {
    const { onSave } = renderEditor();
    const kind = screen.getByLabelText("Phase 1 end condition: kind");
    for (const [choice] of CONDITION_CHOICES) {
      await userEvent.selectOptions(kind, choice);
      expect(status(), choice).toMatch(/^Valid\. Saves as revision 1, [0-9a-f]{12}\.$/);
    }
    // The last choice is "all of"; its part is itself a builder with every kind.
    await userEvent.selectOptions(
      screen.getByLabelText("Phase 1 end condition, part 1: kind"),
      "between",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save the plan" }));
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved?.phases[0]?.end.when).toEqual({
      kind: "all",
      of: [{ kind: "value", value: "engine-speed", op: "between", min: 0, max: 100 }],
    });
  });

  it("shows each problem beside its phase and will not save until it is fixed", async () => {
    const { onSave } = renderEditor();
    const timeout = screen.getByLabelText("Phase 1 end condition: timeout in seconds");
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "5");
    const problems = screen.getByRole("list", { name: "Problems in Phase 1" });
    expect(problems).toHaveTextContent(
      "end.timeout: the timeout of 5 s is not longer than the 10 s the condition needs",
    );
    expect(status()).toMatch(/^Not valid yet: 1 problem/);
    expect(screen.getByRole("button", { name: "Save the plan" })).toBeDisabled();
    await userEvent.type(timeout, "0");
    expect(screen.queryByRole("list", { name: "Problems in Phase 1" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save the plan" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("refuses raw JSON naming an unknown value, listing the valid names", async () => {
    const { onSave } = renderEditor();
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const text = screen.getByLabelText("Plan JSON");
    const document = JSON.stringify({ ...blankPlan(), needs: { values: ["engine-sped"] } });
    await userEvent.clear(text);
    await userEvent.click(text);
    await userEvent.paste(document);
    await userEvent.click(screen.getByRole("button", { name: "Check and use this JSON" }));
    expect(screen.getByRole("list", { name: "Problems in the JSON" })).toHaveTextContent(
      /needs\.values: unknown value engine-sped; valid values: .*engine-speed/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save the plan" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("adds, reorders and removes phases", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add a phase" }));
    const title = screen.getByLabelText("Phase 2: title");
    await userEvent.clear(title);
    await userEvent.type(title, "Second");
    await userEvent.click(screen.getByRole("button", { name: "Move Phase 2 up" }));
    const legends = () =>
      screen.getAllByRole("group").flatMap((group) => {
        const name = group.getAttribute("aria-label");
        return name?.startsWith("Phase ") === true ? [name] : [];
      });
    expect(legends()).toEqual(["Phase 1: Second", "Phase 2: Phase 1"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Phase 1" }));
    expect(legends()).toEqual(["Phase 1: Phase 1"]);
    expect(screen.getByRole("button", { name: "Remove Phase 1" })).toBeDisabled();
  });

  it("previews exactly what the person recording sees", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByLabelText("Preview of what the person recording sees");
    expect(preview).toHaveTextContent("At the car: Parked, handbrake on, in neutral or P");
    expect(within(preview).getByRole("list", { name: "Phases of My plan" })).toHaveTextContent(
      "Ends when 10 s (at most 30 s, then skip).",
    );
  });

  it("raises the revision only when a saved edit changes the plan", () => {
    const plan = pedalPlan();
    expect(revised(plan, plan).revision).toBe(2);
    expect(revised({ ...plan, title: "Changed" }, plan).revision).toBe(3);
    expect(revised(plan, undefined).revision).toBe(2);
  });
});

describe("My plans", () => {
  it("creates, duplicates and deletes plans in the database", async () => {
    const storage = new MemoryStorage();
    await keepPlan(storage, pedalPlan(), "local", "a");
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await userEvent.click(screen.getByRole("tab", { name: "Guide" }));
    const list = await screen.findByRole("list", { name: "My plans" });
    expect(await within(list).findByText(/revision 2, [0-9a-f]{12}, 2 phases/)).toBeVisible();
    await userEvent.click(within(list).getByRole("button", { name: "Duplicate" }));
    await waitFor(async () => {
      expect((await storage.listPlans()).map((plan) => plan.title).sort()).toEqual([
        "Accelerator pedal check",
        "Accelerator pedal check (copy)",
      ]);
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Accelerator pedal check (copy)" }),
    );
    await waitFor(async () => {
      expect(await storage.listPlans()).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole("button", { name: "New plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save the plan" }));
    await waitFor(async () => {
      expect((await storage.listPlans()).map((plan) => plan.origin)).toEqual(["local", "local"]);
    });
  });
});

describe("a plan link", () => {
  it("shows the plan read-only and opens it in Guide ready to record", async () => {
    const storage = new MemoryStorage();
    window.location.hash = await fragmentOf(planEnvelope(pedalPlan(), T0));
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    expect(await screen.findByText("From a link, not your adapter")).toBeVisible();
    const card = (await screen.findByText(/Plan pedal-check, revision 2, /)).closest("section");
    expect(
      screen.getByRole("list", { name: "Phases of Accelerator pedal check" }),
    ).toHaveTextContent("Press the pedal slowly to the floor, then release it.");
    expect(card ?? document.body).toHaveTextContent("At the car: Parked, handbrake on");
    await userEvent.click(screen.getByRole("button", { name: "Open in Guide" }));
    const record = await screen.findByRole("button", { name: "Record Accelerator pedal check" });
    expect(record).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toBe("");
    const stored = await storage.listPlans();
    expect(stored.map((plan) => plan.origin)).toEqual(["shared"]);
    expect(screen.getByRole("button", { name: "Start the plan" })).toBeDisabled();
  });

  it("saves the plan to My plans, marked as shared", async () => {
    const storage = new MemoryStorage();
    window.location.hash = await fragmentOf(planEnvelope(pedalPlan(), T0));
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    await screen.findByText(/Plan pedal-check, revision 2, /);
    const save = screen.getByRole("button", { name: /Save to my plans|Saved/ });
    if (save.textContent === "Save to my plans") await userEvent.click(save);
    await waitFor(async () => {
      expect((await storage.listPlans()).map((plan) => [plan.title, plan.origin])).toEqual([
        ["Accelerator pedal check", "shared"],
      ]);
    });
  });

  it("shows every problem of an invalid plan and offers nothing to run", async () => {
    const { uncheckedFragment } = await import("../../test/support/hostile-share");
    window.location.hash = await uncheckedFragment(
      "plan",
      {
        v: 1,
        kind: "plan",
        createdAt: T0,
        data: { plan: { ...blankPlan(), needs: { values: ["engine-sped"] }, clear: true } },
      },
      streamShareCodec,
    );
    renderApp(<App support={CHROME} />);
    const problems = await screen.findByRole("list", { name: "Problems in the link" });
    expect(problems).toHaveTextContent("unknown value engine-sped");
    expect(problems).toHaveTextContent("Unrecognized key");
    expect(screen.queryByRole("button", { name: "Open in Guide" })).not.toBeInTheDocument();
  });
});

describe("a results link", () => {
  it("shows the plan, its phases and the graphs with phase boundaries, without the plan kept", async () => {
    const storage = new MemoryStorage();
    const plan = pedalPlan();
    const envelope = runShareEnvelope(
      {
        profile: "generic",
        adapter: "simulator",
        startedAt: T0,
        stoppedAt: T0 + 10_000,
        notes: "",
      },
      recordedSamples(plan),
      T0,
    );
    window.location.hash = await fragmentOf(envelope);
    renderApp(<App support={CHROME} />, createTestService(storage), sessionOver(storage));
    expect(await screen.findByText("Results of Accelerator pedal check")).toBeVisible();
    const phases = screen.getByRole("table", { name: "Phases of the shared result" });
    expect(within(phases).getByText("Press the pedal")).toBeVisible();
    expect(screen.getByRole("table", { name: "Fault code changes" })).toHaveTextContent("P2138");
    expect(screen.getByRole("figure")).toHaveTextContent("Idle");
    expect(screen.getByRole("figure")).toHaveTextContent("Press the pedal");
    await userEvent.click(screen.getByRole("button", { name: "Show the plan" }));
    expect(screen.getByRole("list", { name: "Phases of Accelerator pedal check" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save this plan to my plans" }));
    await waitFor(async () => {
      expect((await storage.listPlans()).map((kept) => kept.name)).toEqual(["pedal-check"]);
    });
  });
});
