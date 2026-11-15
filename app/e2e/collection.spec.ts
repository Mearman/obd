import { expect, test, type Page } from "@playwright/test";

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The number in the Samples cell of the only run listed. */
async function sampleCount(page: Page): Promise<number> {
  const cell = page.getByRole("table", { name: "Collection runs" }).getByRole("cell").nth(2);
  return Number(await cell.innerText());
}

test("a simulator collection is stored, survives a reload and resumes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();

  await openScreen(page, "Live");
  await expect(page.getByText(/No web API guarantees collection in the background/)).toBeVisible();
  await page.getByRole("button", { name: "Start collecting" }).click();
  await expect(page.getByText("engine speed")).toBeVisible();
  await expect(page.getByText("Collecting", { exact: true })).toBeVisible();

  await openScreen(page, "Runs");
  const table = page.getByRole("table", { name: "Collection runs" });
  await expect(table.getByText("Simulated")).toBeVisible();
  await expect.poll(() => sampleCount(page)).toBeGreaterThan(2);
  const before = await sampleCount(page);

  // The worker, the collector and the page's state are all gone after a reload; only storage stays.
  await page.reload();
  await openScreen(page, "Runs");
  await expect(page.getByRole("table", { name: "Collection runs" })).toBeVisible();
  expect(await page.getByRole("table", { name: "Collection runs" }).getByRole("row").count()).toBe(
    2,
  );

  // The open simulator run is resumed on its own: it carries on storing into the same run.
  await expect(
    page.getByRole("table", { name: "Collection runs" }).getByText("Collecting"),
  ).toBeVisible();
  await expect.poll(() => sampleCount(page)).toBeGreaterThan(before);
  await openScreen(page, "Live");
  await expect(page.getByText("engine speed")).toBeVisible();

  await page.getByRole("button", { name: "Stop collecting" }).click();
  await openScreen(page, "Runs");
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  const stopped = await sampleCount(page);
  await page.waitForTimeout(1500);
  await openScreen(page, "Live");
  await openScreen(page, "Runs");
  expect(await sampleCount(page)).toBe(stopped);
});
