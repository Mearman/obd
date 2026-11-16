import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryStorage,
  decodeShare,
  fragmentOfLink,
  simulatorUrl,
  withPlan,
  type PlanClock,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideScreen } from "../src/screens/GuideScreen";
import { APP_VERSION } from "../src/release/release";
import { openFakeTab, type FakeTab } from "./fake-updates";
import { createTestService, renderApp, type TestService } from "./render";

const GENERIC = simulatorUrl("generic-obd2");

/** A plan clock the test moves: each sleep waits until the test steps to it, so a phase of minutes passes in a few steps and the screen can be read in between. */
class ManualClock implements PlanClock {
  time = 1_700_000_000_000;
  private sleepers: { due: number; resolve: () => void }[] = [];

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ due: this.time + Math.max(1, milliseconds), resolve });
    });
  }

  /** Moves to the earliest sleeper's time and wakes it; false when nothing sleeps. */
  step(): boolean {
    this.sleepers.sort((a, b) => a.due - b.due);
    const next = this.sleepers.shift();
    if (next === undefined) return false;
    this.time = Math.max(this.time, next.due);
    next.resolve();
    return true;
  }
}

/** Steps the clock, letting the runner and the screen catch up between steps, until `done` holds. */
async function advanceUntil(clock: ManualClock, done: () => boolean): Promise<void> {
  for (let step = 0; step < 2000; step++) {
    if (done()) return;
    await act(async () => {
      clock.step();
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error("the plan did not get there");
}

function planFile(name: string, phases: unknown[]): File {
  const text = JSON.stringify({
    format: "obd-read-plan",
    version: 1,
    name: "screen-test",
    title: "Screen test",
    description: "A plan for the screen tests, parked with the handbrake on.",
    source: "A test.",
    needs: { values: ["engine-speed", "coolant-temperature", "vehicle-speed"] },
    phases,
  });
  return new File([text], name, { type: "application/json" });
}

const TIMED = {
  id: "idle",
  title: "Idle",
  instruction: "Let the engine idle without touching the pedal.",
  reads: { start: ["stored-codes"], end: ["stored-codes"] },
  end: { when: { kind: "elapsed", seconds: 5 }, timeout: 30 },
};

const CONFIRMED = {
  id: "ready",
  title: "Ready",
  instruction: "Switch the engine off.",
  end: { when: { kind: "confirm", prompt: "Is the engine off?" }, timeout: 600 },
};

async function guide(options: { connect?: boolean; storage?: MemoryStorage } = {}): Promise<{
  service: TestService;
  clock: ManualClock;
  onOpenRun: ReturnType<typeof vi.fn>;
  tab: FakeTab;
}> {
  const clock = new ManualClock();
  const service = createTestService(options.storage, { planClock: clock });
  if (options.connect !== false) await service.client.link.connect({ adapter: GENERIC });
  const onOpenRun = vi.fn<(runId: string) => void>();
  const tab = openFakeTab(APP_VERSION);
  await renderApp(<GuideScreen onOpenRun={onOpenRun} />, service, undefined, undefined, tab);
  await screen.findByRole("button", { name: "Import a plan file" });
  return { service, clock, onOpenRun, tab };
}

async function importAndStart(file: File): Promise<void> {
  await userEvent.upload(screen.getByLabelText("Plan file"), file);
  await screen.findByRole("button", { name: "From file: Screen test", pressed: true });
  await userEvent.click(screen.getByRole("button", { name: "Start the plan" }));
  await screen.findByRole("region", { name: "Current phase" });
}

function phaseCard(): HTMLElement {
  return screen.getByRole("region", { name: "Current phase" });
}

/** The card a heading titles. */
function cardOf(heading: HTMLElement): HTMLElement {
  const card = heading.closest("section");
  if (card === null) throw new Error("the heading is not in a card");
  return card;
}

function hasText(text: string | RegExp): boolean {
  return screen.queryByText(text) !== null;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "vibrate");
});

describe("the Guide screen", () => {
  it("lists the shipped plans and previews the chosen one's phases", async () => {
    await guide();
    await userEvent.click(
      await screen.findByRole("button", { name: "Idle, hold revs, idle, blips" }),
    );
    const phases = screen.getByRole("list", { name: "Phases of Idle, hold revs, idle, blips" });
    expect(within(phases).getByText("Hold steady revs")).toBeVisible();
    expect(
      within(phases).getByText(
        "Ends when engine-speed between 2000 and 2500 for 60 s (at most 240 s, then skip).",
      ),
    ).toBeVisible();
    expect(
      within(phases).getByText(
        "Starts when engine-speed > 300 for 3 s (at most 120 s, then fail).",
      ),
    ).toBeVisible();
    expect(
      within(phases).getAllByText(/^Samples every value the car reports, every 1 s/),
    ).not.toEqual([]);
    // The plan's own safety text stands apart above the phases.
    expect(screen.getByText("At the car:").closest("p")).toHaveTextContent(
      /parked, handbrake on, in neutral or P, in a ventilated space; nobody drives/,
    );
    expect(screen.getByRole("button", { name: "Start the plan" })).toBeEnabled();
  });

  it("refuses to start with no connection and says why", async () => {
    await guide({ connect: false });
    await userEvent.click(
      await screen.findByRole("button", { name: "Idle, hold revs, idle, blips" }),
    );
    expect(screen.getByRole("button", { name: "Start the plan" })).toBeDisabled();
    expect(screen.getByText(/Connect an adapter first/)).toBeVisible();
  });

  it("shows the problems of an imported plan that is not valid", async () => {
    await guide();
    const misspelt = planFile("bad.obdplan.json", [
      { ...TIMED, end: { when: { kind: "value", value: "engine-sped", op: ">", than: 1 } } },
    ]);
    await userEvent.upload(screen.getByLabelText("Plan file"), misspelt);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("bad.obdplan.json is not a plan this app can run");
    expect(alert).toHaveTextContent(/unknown value engine-sped; valid values: .*engine-speed/);
    expect(screen.queryByRole("button", { name: /^From file/ })).toBeNull();
  });

  it("counts down a timed phase, waits for a confirmation and summarises the run", async () => {
    const vibrate = vi.fn<(pattern: number) => boolean>(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const { clock, onOpenRun } = await guide();
    await importAndStart(planFile("two.obdplan.json", [TIMED, CONFIRMED]));

    await advanceUntil(clock, () => hasText("Let the engine idle without touching the pedal."));
    const card = phaseCard();
    expect(within(card).getByText("Phase 1 of 2")).toBeVisible();
    expect(within(card).getByText("Ends when 5 s")).toBeVisible();
    await advanceUntil(clock, () => within(phaseCard()).queryByLabelText("Live values") !== null);
    expect(within(phaseCard()).getByText("engine speed")).toBeVisible();
    expect(within(phaseCard()).getByLabelText("Time left in this phase")).toHaveTextContent(/s$/);
    expect(screen.getByRole("status", { name: "Phase announcements" })).toHaveTextContent(
      "Phase 1 of 2: Idle. Let the engine idle without touching the pedal.",
    );

    await advanceUntil(clock, () => hasText("Phase 2 of 2"));
    const confirm = await screen.findByRole("button", { name: "Is the engine off? Confirm" });
    expect(screen.getByRole("status", { name: "Phase announcements" })).toHaveTextContent(
      "Phase 2 of 2: Ready. Switch the engine off.",
    );
    expect(vibrate).toHaveBeenCalledTimes(2);
    await userEvent.click(confirm);

    const summary = cardOf(await screen.findByRole("heading", { name: "Summary" }));
    expect(within(summary).getByText("The plan finished.")).toBeVisible();
    const phases = within(summary).getByRole("table", { name: "Phases of the plan" });
    expect(within(phases).getAllByText("completed")).toHaveLength(2);
    expect(within(phases).getByText("5.0 s")).toBeVisible();
    expect(
      within(summary).getByText("At the start: P0420 (7E8). At the end: P0420 (7E8)."),
    ).toBeVisible();
    for (const format of ["CSV", "TSV", "JSON"]) {
      expect(within(summary).getByRole("button", { name: `Export ${format}` })).toBeVisible();
    }
    await userEvent.click(within(summary).getByRole("button", { name: "Send results back" }));
    const dialog = await screen.findByRole("dialog", { name: "Send the results back" });
    expect(within(dialog).getByRole("switch")).toBeChecked();
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Link").textContent).toContain("#share=2.");
    });
    const fragment = fragmentOfLink(within(dialog).getByLabelText("Link").textContent);
    if (fragment === undefined) throw new Error("no fragment");
    const decoded = await decodeShare(fragment, streamShareCodec);
    if (!decoded.ok || decoded.value.kind !== "plan-result") throw new Error("not a plan result");
    expect(decoded.value.data.plan.name).toBe("screen-test");
    expect(decoded.value.data.phases.map((pass) => pass.outcome)).toEqual([
      "completed",
      "completed",
    ]);
    expect(decoded.value.data.redacted).toBe(true);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(summary).getByRole("button", { name: "Open the run in the Library" }),
    );
    expect(onOpenRun).toHaveBeenCalledWith(expect.any(String));
    await userEvent.click(within(summary).getByRole("button", { name: "Record another" }));
    expect(await screen.findByRole("button", { name: "Start the plan" })).toBeVisible();
  });

  it("ends a phase when a value condition holds", async () => {
    const { clock } = await guide();
    await importAndStart(
      planFile("revs.obdplan.json", [
        {
          id: "revs",
          title: "Revs",
          instruction: "Hold the revs.",
          end: {
            when: { kind: "value", value: "engine-speed", op: ">", than: 900 },
            timeout: 600,
            onTimeout: "fail",
          },
        },
      ]),
    );
    await advanceUntil(clock, () => hasText("Ends when engine-speed > 900"));
    await advanceUntil(clock, () => hasText("The plan finished."));
    const phases = screen.getByRole("table", { name: "Phases of the plan" });
    expect(within(phases).getByText("completed")).toBeVisible();
  });

  it("goes on after a wait that times out with skip and stops after one that fails", async () => {
    const { clock } = await guide();
    await importAndStart(
      planFile("timeouts.obdplan.json", [
        { ...CONFIRMED, id: "first", end: { ...CONFIRMED.end, timeout: 5, onTimeout: "skip" } },
        { ...CONFIRMED, id: "second", end: { ...CONFIRMED.end, timeout: 5, onTimeout: "fail" } },
      ]),
    );
    await advanceUntil(clock, () => hasText(/The plan stopped early/));
    expect(
      screen.getByText(/phase second timed out waiting for Is the engine off\?/),
    ).toBeVisible();
    const notices = within(screen.getByRole("list", { name: "Notices" })).getAllByRole("listitem");
    // The first wait skips on, the second ends the plan, each with its time.
    expect(notices.map((notice) => notice.textContent)).toEqual([
      expect.stringMatching(
        /UTC \(\+\d.*\): Timed out waiting for the phase to end; going on to the next phase\.$/,
      ),
      expect.stringMatching(
        /UTC \(\+\d.*\): Timed out waiting for the phase to end; the plan stops\.$/,
      ),
    ]);
    const phases = screen.getByRole("table", { name: "Phases of the plan" });
    expect(within(phases).getAllByText("timed-out")).toHaveLength(2);
  });

  it("skips a phase and aborts the plan", async () => {
    const { clock } = await guide();
    await importAndStart(
      planFile("abort.obdplan.json", [CONFIRMED, { ...CONFIRMED, id: "again", title: "Again" }]),
    );
    await screen.findByRole("button", { name: "Is the engine off? Confirm" });
    await userEvent.click(screen.getByRole("button", { name: "Skip this phase" }));
    await advanceUntil(clock, () => hasText("Phase 2 of 2"));
    await userEvent.click(screen.getByRole("button", { name: "Abort the plan" }));
    await advanceUntil(clock, () => hasText(/The plan was aborted/));
    const phases = screen.getByRole("table", { name: "Phases of the plan" });
    expect(within(phases).getByText("skipped")).toBeVisible();
    expect(within(phases).getByText("aborted")).toBeVisible();
  });

  it("holds a new version back while a plan records, and applies it once the plan ends", async () => {
    const { clock, tab } = await guide();
    await importAndStart(planFile("update.obdplan.json", [CONFIRMED]));
    act(() => {
      tab.updater.waiting();
    });
    expect(tab.updater.status().waitingFor).toContain("a recording plan");
    expect(tab.worker.activate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Abort the plan" }));
    await advanceUntil(clock, () => hasText(/The plan was aborted/));
    await waitFor(
      () => {
        expect(tab.worker.activate).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000 },
    );
    expect(tab.page.reloads()).toBe(1);
  });

  it("says a plan left running by a reload has stopped, and keeps its run", async () => {
    const storage = new MemoryStorage();
    await storage.createRun({
      profile: "generic-obd2",
      adapter: GENERIC,
      startedAt: 1_700_000_000_000,
      notes: withPlan("plan idle-then-rev: Idle, hold revs, idle, blips", "idle-then-rev"),
    });
    const { onOpenRun } = await guide({ storage });
    const notice = cardOf(await screen.findByRole("heading", { name: "Stopped by a reload" }));
    expect(within(notice).getByText(/plan idle-then-rev: Idle, hold revs/)).toBeVisible();
    await userEvent.click(within(notice).getByRole("button", { name: "Open in the Library" }));
    expect(onOpenRun).toHaveBeenCalled();
    await waitFor(async () => {
      expect((await storage.listRuns({}))[0]?.stoppedAt).not.toBeNull();
    });
  });
});
