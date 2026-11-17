import { expect, test } from "@playwright/test";
import { openSection } from "./session";
import { shareLinkOfSimulatorScan } from "./share-links";
import { fits } from "./layout";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

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

        await page.goto("/?screen=library");
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await fits(page, "the empty Library");
        await page.screenshot({ path: `${base}-library-empty.png` });

        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Read");
        await page.getByRole("button", { name: "Capture everything" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Share the capture" })).toBeVisible();
        await fits(page, "the capture viewer");
        await page.screenshot({ path: `${base}-capture-full.png`, fullPage: true });

        await page.getByRole("button", { name: "Share the capture" }).click();
        await page.getByRole("menuitem", { name: "The raw capture" }).click();
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

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`dialogs ${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("a run's menu and dialogs, and the problem report, fit and have large targets", async ({
        page,
      }) => {
        const base = `screenshots/dialogs-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Live");
        await page.getByRole("button", { name: "Start collecting" }).click();
        await expect(page.getByRole("button", { name: "Stop collecting" })).toBeVisible();
        await page.getByRole("button", { name: "Stop collecting" }).click();
        await page.getByRole("tab", { name: "Library" }).click();
        await expect(page.getByRole("table", { name: "Library" })).toBeVisible();

        await fits(page, "the Library with a run");
        await page.getByRole("button", { name: /^Export run/ }).click();
        await expect(page.getByRole("menuitem", { name: "CSV" })).toBeVisible();
        await fits(page, "the Export menu");
        await page.screenshot({ path: `${base}-export-menu.png` });
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: /^Fault codes of run/ }).click();
        await expect(page.getByRole("dialog", { name: "Fault codes" })).toBeVisible();
        await fits(page, "the fault codes dialog");
        await page.screenshot({ path: `${base}-fault-codes.png` });
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Share", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Share this run's summary" })).toBeVisible();
        await fits(page, "the run share dialog");
        await page.screenshot({ path: `${base}-run-share.png` });
      });
    });
  }
}
