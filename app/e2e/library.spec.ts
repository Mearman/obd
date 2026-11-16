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

/** The narrowest phone the tab bar must fit without scrolling. */
const NARROWEST = { width: 320, height: 640 } as const;

const INTERACTIVE =
  'button, a[href], [role="tab"], [role="switch"], [role="combobox"], input:not([hidden]):not([type="hidden"])';

/** A run's CSV export: the two fixed columns, then one per signal. */
const RUN_CSV =
  "time,elapsed (s),speed (km/h)\r\n2026-11-15T10:00:01.000Z,1.000,50\r\n2026-11-15T10:00:02.000Z,2.000,60\r\n";

/** An adapter transcript: each line a timestamp, then `>` for a request or `<` for a reply. */
const TRANSCRIPT = [
  "2026-01-02T03:04:05.000+00:00 > ATSP6",
  "2026-01-02T03:04:05.050+00:00 < OK",
  "2026-01-02T03:04:05.100+00:00 > 0100",
  "2026-01-02T03:04:05.150+00:00 < 7E8 06 41 00 08 18 00 00",
].join("\n");

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** How far the tab bar's labels run past its width; the bar scrolls rather than overflowing the page, so the page check alone would miss a clipped tab. */
async function tabBarOverflow(page: Page): Promise<number> {
  return page
    .getByRole("tablist", { name: "Screens" })
    .evaluate((bar) => bar.scrollWidth - bar.clientWidth);
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
  expect(await tabBarOverflow(page), `the tab bar is clipped on ${what}`).toBeLessThanOrEqual(0);
  expect(await horizontalOverflow(page), `${what} overflows horizontally`).toBeLessThanOrEqual(0);
  expect(
    await undersizedTargets(page),
    `${what} has targets under ${String(MIN_TARGET)} px`,
  ).toEqual([]);
}

/** Imports `text` as the file `name` through the Library's one import control. */
async function importFile(page: Page, name: string, text: string): Promise<void> {
  await page.getByLabel("Capture, saved scan, transcript or run file").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
}

/** The kind badge of each row the Library lists, top to bottom. */
async function kindsListed(page: Page): Promise<string[]> {
  return page
    .getByRole("table", { name: "Library" })
    .getByRole("rowgroup")
    .nth(1)
    .getByRole("row")
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('[role="cell"]')?.textContent ?? ""),
    );
}

/** Scans the simulator, which keeps a report, then imports a run and a transcript in the Library. */
async function fillLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /^Scan of / })).toBeVisible();
  await expect(page.getByRole("table", { name: "Saved reports" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await importFile(page, "run.csv", RUN_CSV);
  await expect(page.getByText("Imported run.csv as a stopped run.")).toBeVisible();
  await importFile(page, "adapter.log", TRANSCRIPT);
  await expect(page.getByRole("status", { name: "Decoding summary" })).toBeVisible();
  // The capture's viewer opens on import in place of the list; close it to see the list.
  await page.getByRole("button", { name: "Close" }).first().click();
  // The scan is from now, the transcript from January and the run from November, so the scan's report leads.
  await expect.poll(() => kindsListed(page)).toEqual(["Report", "Run", "Capture"]);
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("the Library lists every kind it imported and fits the screen", async ({ page }) => {
        await fillLibrary(page);
        await fits(page, "the Library");
        const base = `screenshots/library-${viewport.name}-${scheme}`;
        await page.screenshot({ path: `${base}.png` });
        await page.screenshot({ path: `${base}-full.png`, fullPage: true });

        await page.getByRole("combobox", { name: "Kind" }).click();
        await page.getByRole("option", { name: "Runs" }).click();
        await expect.poll(() => kindsListed(page)).toEqual(["Run"]);
        await expect(page).toHaveURL(/[?&]kind=run(&|$)/);
        await page
          .getByRole("row", { name: /^Open run / })
          .getByRole("cell")
          .first()
          .click();
        await expect(page.getByRole("group", { name: "Run playback" })).toBeVisible();
        await fits(page, "the Library with a run's graphs");
        await page.screenshot({ path: `${base}-run.png`, fullPage: true });
      });
    });
  }
}

test("every tab fits the narrowest phone in keyboard order, with large targets", async ({
  page,
}) => {
  await page.setViewportSize(NARROWEST);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Session" })).toBeVisible();
  expect(await tabBarOverflow(page), "the tab bar is clipped").toBeLessThanOrEqual(0);
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(["Session", "Library", "Guide", "Settings"]);
  const boxes = await tabs.evaluateAll((all) =>
    all.map((tab) => {
      const box = tab.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  // Arrow keys move along the bar in the order it reads, opening each screen in turn.
  await tabs.first().click();
  for (const name of ["Library", "Guide", "Settings"]) {
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name })).toBeFocused();
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  }
  await page.screenshot({ path: "screenshots/library-narrowest-tabs.png" });
});
