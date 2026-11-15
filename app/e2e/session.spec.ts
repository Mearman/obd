import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./session";

const VIEWPORTS = [
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

      test("connects, reads, collects and opens Advanced on one screen", async ({ page }) => {
        const base = `screenshots/session-${viewport.name}-${scheme}`;
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();
        await expect(page.getByText("Not connected", { exact: true }).last()).toBeVisible();
        await fits(page, "the disconnected Session");
        await page.screenshot({ path: `${base}-disconnected.png` });
        await page.screenshot({ path: `${base}-disconnected-full.png`, fullPage: true });

        await openSection(page, "Read");
        const read = page.locator("#session-read");
        await expect(read.getByRole("note")).toContainText("Connect first");
        await expect(read.getByRole("button", { name: "Start scan" })).toBeDisabled();
        await fits(page, "the disconnected Read section");
        await read.getByRole("button", { name: "Open Connection" }).click();

        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        const disconnect = page.getByRole("button", { name: "Disconnect" });
        await expect(disconnect).toBeVisible();
        await fits(page, "the connected Session");

        await openSection(page, "Read");
        await page.getByRole("button", { name: "Start scan" }).click();
        await expect(page.getByRole("table", { name: /^Scan of / })).toBeVisible();
        await fits(page, "the Read section");
        await page.screenshot({ path: `${base}-read.png` });
        await page.screenshot({ path: `${base}-read-full.png`, fullPage: true });

        // The connection stays in view in the sticky bar while the page scrolls.
        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await expect(disconnect).toBeInViewport();

        await openSection(page, "Live");
        await page.getByRole("button", { name: "Start collecting" }).click();
        await expect(
          page
            .getByRole("table", { name: /^Live values: / })
            .getByText("engine speed", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Collecting", { exact: true })).toBeVisible();
        await fits(page, "the Live section");
        await page.screenshot({ path: `${base}-live.png` });
        await page.screenshot({ path: `${base}-live-full.png`, fullPage: true });
        await page.getByRole("button", { name: "Stop collecting" }).click();
        await expect(page.getByRole("button", { name: "Start collecting" })).toBeVisible();

        await openSection(page, "Advanced");
        await expect(page.getByRole("button", { name: "Write a value" })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
        ).toBeEnabled();
        await fits(page, "the Advanced section");
        await page.screenshot({ path: `${base}-advanced.png` });

        await disconnect.click();
        await expect(
          page.getByRole("button", { name: /connect with the simulator/i }),
        ).toBeVisible();
      });
    });
  }
}
