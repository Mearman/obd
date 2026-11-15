import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

/** The smallest touch target, in CSS pixels. */
const MIN_TARGET = 44;

const INTERACTIVE =
  'button, a[href], [role="tab"], [role="switch"], [role="combobox"], input:not([hidden]):not([type="hidden"])';

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

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function undersizedTargets(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ selector, min }) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width < min || box.height < min)
        .map(
          ({ element, box }) =>
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent).trim().slice(0, 30)}" ${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
        ),
    { selector: INTERACTIVE, min: MIN_TARGET },
  );
}

/** How far the tab bar's labels run past its width; the bar scrolls rather than overflowing the page, so the page check alone would miss a clipped tab. */
async function tabBarOverflow(page: Page): Promise<number> {
  return page
    .getByRole("tablist", { name: "Screens" })
    .evaluate((bar) => bar.scrollWidth - bar.clientWidth);
}

async function fits(page: Page, what: string): Promise<void> {
  expect(await tabBarOverflow(page), `the tab bar is clipped on ${what}`).toBeLessThanOrEqual(0);
  expect(await horizontalOverflow(page), `${what} overflows horizontally`).toBeLessThanOrEqual(0);
  expect(
    await undersizedTargets(page),
    `${what} has targets under ${String(MIN_TARGET)} px`,
  ).toEqual([]);
}

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
