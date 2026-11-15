import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "narrow", width: 320, height: 640 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

/** The smallest touch target, in CSS pixels. */
const MIN_TARGET = 44;

const INTERACTIVE =
  'button, a[href], [role="tab"], [role="switch"], [role="combobox"], [role="checkbox"], input:not([hidden]):not([type="hidden"])';

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

async function fits(page: Page, what: string): Promise<void> {
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

      test("collects with a preset, stops, and fits with large targets", async ({ page }) => {
        const base = `screenshots/live-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await page.getByRole("tab", { name: "Live" }).click();

        const engine = page.getByRole("button", { name: "Engine", exact: true });
        await expect(engine).toHaveAttribute("aria-pressed", "true");
        await fits(page, "the picker");
        await page.screenshot({ path: `${base}-picker.png`, fullPage: true });

        await engine.click();
        await page.getByRole("button", { name: "Start collecting" }).click();
        await expect(page.getByText("engine speed")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Search values" })).toBeVisible();
        await fits(page, "the readings");
        await page.screenshot({ path: `${base}-readings.png`, fullPage: true });

        await page.getByRole("button", { name: "Pin vehicle speed" }).click();
        await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
        await fits(page, "the pinned readings");

        await page.getByRole("button", { name: "Stop collecting" }).click();
        await expect(page.getByRole("button", { name: "Start collecting" })).toBeVisible();
        await fits(page, "the stopped screen");

        await page.getByRole("tab", { name: "Library" }).click();
        await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
        await expect(page.getByText("Stopping…")).toBeHidden();
        await fits(page, "the Library");
      });
    });
  }
}
