import { expect, test } from "@playwright/test";
import { readReleasedVersion } from "../app-version";

const version = readReleasedVersion();

test("Settings shows the running version and checks for a new one on demand", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByRole("tab", { name: "Settings" }).click();

  const card = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Version and updates" }) });
  await expect(card.getByText(`Running version ${version}.`)).toBeVisible();
  const checked = card.getByRole("status");
  // The check at start is skipped while the first worker is still installing, so press the button.
  await expect(card.getByRole("button", { name: "Check now" })).toBeEnabled();
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(card.getByRole("button", { name: "Check now" })).toBeEnabled();
  await expect(checked).toHaveText(/^Last checked for a new version on /);
  await expect(checked).not.toHaveText(/failed/);
  expect(errors).toEqual([]);
});
