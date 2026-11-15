import { expect, type Page } from "@playwright/test";
import { openSection } from "./session";
import { chooseProfile } from "./profile";

/** What the page's real database holds as saved scan reports. */
export async function savedReports(page: Page) {
  return page.evaluate(async () => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    const summaries = await database.storage.listScanReports({});
    return Promise.all(
      summaries.map(async (summary) => ({
        summary,
        saved: await database.storage.getScanReport(summary.id),
      })),
    );
  });
}

/** Scans the simulated Volkswagen on `page` and returns the link its Share dialog makes. */
export async function shareLinkOfSimulatorScan(page: Page, redact: boolean): Promise<string> {
  await page.goto("/");
  await chooseProfile(page, "vag-mqb");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of vag-mqb/ })).toBeVisible();
  await page.getByRole("button", { name: "Share scan" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this scan" });
  const toggle = dialog.getByRole("switch", { name: /remove the vin/i });
  await expect(toggle).toBeChecked();
  if (!redact) await toggle.click();
  await expect(dialog.getByText(/characters$/)).toBeVisible();
  const link = await dialog.getByLabel("Link", { exact: true }).innerText();
  expect(link).toContain("#share=2.");
  return link;
}
