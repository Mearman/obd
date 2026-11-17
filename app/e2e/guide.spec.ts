import { expect, test } from "@playwright/test";
import { fits } from "./layout";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

/** A short plan: a phase that waits for the person, so the running card can be checked at rest, then a timed phase that reads the codes. */
const PLAN = JSON.stringify({
  format: "obd-read-plan",
  version: 1,
  name: "e2e-short",
  title: "Short end-to-end plan",
  description: "Parked with the handbrake on: a confirmation, then two seconds of idle.",
  source: "The end-to-end tests.",
  needs: { values: ["engine-speed", "coolant-temperature", "vehicle-speed"] },
  phases: [
    {
      id: "ready",
      title: "Get ready",
      instruction: "Parked, handbrake on, in neutral or P: start the engine and let it idle.",
      end: { when: { kind: "confirm", prompt: "Is the engine idling?" }, timeout: 600 },
    },
    {
      id: "idle",
      title: "Idle",
      instruction: "Leave the engine idling without touching the pedal.",
      reads: { start: ["stored-codes"], end: ["stored-codes"] },
      end: { when: { kind: "elapsed", seconds: 2 }, timeout: 30 },
    },
  ],
});

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("a recording plan runs against the simulator from picker to summary", async ({
        page,
      }) => {
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await page.getByRole("tab", { name: "Guide" }).click();
        await page.getByRole("button", { name: "Idle, hold revs, idle, blips" }).click();
        await expect(page.getByRole("list", { name: /^Phases of / })).toBeVisible();
        await fits(page, "the picker");

        await page.getByLabel("Plan file").setInputFiles({
          name: "short.obdplan.json",
          mimeType: "application/json",
          buffer: Buffer.from(PLAN),
        });
        await expect(
          page.getByRole("button", { name: "From file: Short end-to-end plan", pressed: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Start the plan" }).click();

        const card = page.getByRole("region", { name: "Current phase" });
        await expect(card.getByText("Phase 1 of 2")).toBeVisible();
        await expect(card.getByLabel("Live values")).toBeVisible();
        const confirm = page.getByRole("button", { name: "Is the engine idling? Confirm" });
        await expect(confirm).toBeVisible();
        await fits(page, "the running phase");
        const base = `screenshots/guide-${viewport.name}-${scheme}`;
        await page.screenshot({ path: `${base}-running.png` });
        await card.screenshot({ path: `${base}-card.png` });

        await confirm.click();
        await expect(card.getByText("Phase 2 of 2")).toBeVisible();
        await expect(page.getByText("The plan finished.")).toBeVisible({ timeout: 15_000 });
        const phases = page.getByRole("table", { name: "Phases of the plan" });
        await expect(phases.getByText("completed")).toHaveCount(2);
        await expect(page.getByText(/At the start: P0420/)).toBeVisible();
        await fits(page, "the summary");
        await page.screenshot({ path: `${base}-summary.png`, fullPage: true });

        await page.getByRole("button", { name: "Open the run in the Library" }).click();
        await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
        await expect(page.getByRole("group", { name: "Run playback" })).toBeVisible();
      });
    });
  }
}

/** A plan that waits for a pending code to appear, then for it to clear, reading nothing else. */
const CODES_PLAN = JSON.stringify({
  format: "obd-read-plan",
  version: 1,
  name: "e2e-codes",
  title: "Pending code end-to-end plan",
  description: "Waits for a pending code to appear and then to clear.",
  source: "The end-to-end tests.",
  needs: { values: ["engine-speed"] },
  phases: [
    {
      id: "appear",
      title: "Appear",
      instruction: "Leave the engine idling.",
      end: { when: { kind: "code-appears", list: "pending" }, timeout: 120 },
    },
    {
      id: "clear",
      title: "Clear",
      instruction: "Leave the engine idling.",
      end: { when: { kind: "code-clears", list: "pending" }, timeout: 120 },
    },
  ],
});

test("a plan on the simulator sees a pending code appear and clear, with a timestamped notice for each", async ({
  page,
}) => {
  // The plan reads the code lists every DEFAULT_CODE_WATCH_INTERVAL_S seconds, and the code clears on the fourth read.
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("switch", { name: /pending fault code that appears, then clears/ }).click();
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await page.getByRole("tab", { name: "Guide" }).click();
  await page.getByLabel("Plan file").setInputFiles({
    name: "codes.obdplan.json",
    mimeType: "application/json",
    buffer: Buffer.from(CODES_PLAN),
  });
  await page.getByRole("button", { name: "Start the plan" }).click();

  const notices = page.getByRole("list", { name: "Notices" });
  await expect(notices.getByText(/^.+: P0300 appeared in the pending codes\.$/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(notices.getByText(/^.+: P0300 cleared from the pending codes\.$/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("The plan finished.")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Phases of the plan" }).getByText("completed"),
  ).toHaveCount(2);
});
