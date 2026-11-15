import { expect, test, type Page } from "@playwright/test";

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

/** The viewer's summary line once it says `pattern`. */
async function expectSummary(page: Page, pattern: RegExp): Promise<void> {
  await expect(page.getByRole("status", { name: "Decoding summary" })).toHaveText(pattern);
}

test("a simulator capture decodes differently under another profile and reopens offline", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByRole("combobox", { name: "Vehicle profile" }).click();
  await page.getByRole("option", { name: /mercedes-w211/ }).click();
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();

  await openScreen(page, "Scan");
  await page.getByRole("button", { name: "Capture everything" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Captures" })).toBeVisible();
  await expectSummary(page, /Decoded \d+ Left raw 0 of \d+ exchanges with mercedes-w211/);
  await expect(page.getByRole("table", { name: "Units decoded with mercedes-w211" })).toBeVisible();

  await page.getByRole("combobox", { name: "Decode with" }).click();
  await page.getByRole("option", { name: "vag-mqb", exact: true }).click();
  await expectSummary(page, /Left raw [1-9]\d* of \d+ exchanges with vag-mqb/);
  await expect(page.getByRole("table", { name: "Exchanges vag-mqb leaves raw" })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Units decoded with vag-mqb" }).getByText("No reply").first(),
  ).toBeVisible();

  // The capture is in the page's database, so it is there after an offline reload.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await openScreen(page, "Captures");
  const listed = page.getByRole("table", { name: "Captures" });
  await expect(listed.getByText("mercedes-w211")).toBeVisible();
  await listed.getByRole("button", { name: /^View capture / }).click();
  await expectSummary(page, /with mercedes-w211/);
  await page.getByRole("combobox", { name: "Decode with" }).click();
  await page.getByRole("option", { name: "Generic OBD-II (no profile)" }).click();
  await expectSummary(page, /Left raw [1-9]\d* of \d+ exchanges with Generic OBD-II/);
  await expect(page.getByText("VIN: SIMULATEDCAR00001").first()).toBeVisible();
  await context.setOffline(false);
});
