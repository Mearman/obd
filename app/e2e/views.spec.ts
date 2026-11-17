import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./session";
import { shareLinkOfSimulatorScan } from "./share-links";

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

async function fits(page: Page, view: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${view} overflows horizontally`).toBeLessThanOrEqual(0);
  const small = await page.evaluate(
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
  expect(small, `${view} has targets under ${String(MIN_TARGET)} px`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("the capture viewer and a shared link fit and have large targets", async ({
        page,
        browser,
      }) => {
        const base = `screenshots/views-${viewport.name}-${scheme}`;

        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Read");
        await page.getByRole("button", { name: "Capture everything" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Share the raw capture" })).toBeVisible();
        await fits(page, "the capture viewer");
        await page.screenshot({ path: `${base}-capture-full.png`, fullPage: true });

        await page.getByRole("button", { name: "Share the raw capture" }).click();
        await expect(page.getByRole("dialog", { name: "Share the raw capture" })).toBeVisible();
        await fits(page, "the share dialog");
        await page.screenshot({ path: `${base}-share-dialog.png` });

        const sender = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
        await sender.close();
        const receiver = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const shared = await receiver.newPage();
        await shared.goto(link);
        await expect(shared.getByRole("heading", { name: "Shared data" })).toBeVisible();
        await fits(shared, "the shared viewer");
        await shared.screenshot({ path: `${base}-shared-full.png`, fullPage: true });
        await receiver.close();
      });
    });
  }
}
