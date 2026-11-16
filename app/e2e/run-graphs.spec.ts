import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./session";

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
  'button, a[href], [role="tab"], [role="switch"], [role="combobox"], [role="slider"], input:not([hidden]):not([type="hidden"])';

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

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

/** The number of samples the Details cell of the only run listed gives. */
async function sampleCount(page: Page): Promise<number> {
  const cell = page.getByRole("table", { name: "Library" }).getByRole("cell").nth(3);
  return Number(/^(\d+) samples?/.exec(await cell.innerText())?.[1]);
}

/** Collects a short simulator run, stops it and opens its graphs. */
async function openCollectedRunGraphs(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();

  await openSection(page, "Live");
  await page.getByRole("button", { name: "Start collecting" }).click();
  await expect(page.getByText("engine speed")).toBeVisible();
  // The live values carry a trend per value while the run collects.
  await expect(page.getByRole("img", { name: "Trend of engine speed" })).toBeVisible();

  await openScreen(page, "Library");
  await expect.poll(() => sampleCount(page)).toBeGreaterThan(6);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();

  await page.getByRole("row", { name: /^Open run / }).click();
  await expect(page.getByRole("group", { name: "Run playback" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("a collected run is graphed, plays and fits the screen", async ({ page }) => {
        await openCollectedRunGraphs(page);

        const charts = page.getByRole("figure");
        expect(await charts.count()).toBeGreaterThan(1);
        const drawing = page.getByRole("img", { name: /^engine speed: \d+ readings/ });
        await expect(drawing).toBeVisible();
        const line = drawing.locator("polyline");
        expect((await line.getAttribute("points"))?.length ?? 0).toBeGreaterThan(0);
        expect(await line.evaluate((element) => getComputedStyle(element).stroke)).not.toBe("none");

        // Play from the start at 4x; it ends on its own and the cursor reaches the end.
        await page.getByRole("button", { name: "4x" }).click();
        await page.getByRole("button", { name: "Play" }).click();
        await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
        const scrubber = page.getByRole("slider", { name: "Position in the run" });
        expect(Number(await scrubber.inputValue())).toBe(
          Number(await scrubber.getAttribute("max")),
        );

        // The cursor shows each signal's value, and the table repeats them as text.
        await page.getByRole("slider", { name: /^Cursor on engine speed/ }).focus();
        await page.keyboard.press("Home");
        await expect(scrubber).toHaveValue("0");
        await page.keyboard.press("ArrowRight");
        await expect(scrubber).not.toHaveValue("0");
        await expect(page.getByRole("table", { name: "Values at the cursor" })).toBeVisible();

        expect(
          await horizontalOverflow(page),
          "the Library with graphs overflows",
        ).toBeLessThanOrEqual(0);
        expect(await undersizedTargets(page), "targets under 44 px").toEqual([]);

        const base = `screenshots/graphs-${viewport.name}-${scheme}`;
        await page.screenshot({ path: `${base}.png` });
        await page.screenshot({ path: `${base}-full.png`, fullPage: true });
      });
    });
  }
}
