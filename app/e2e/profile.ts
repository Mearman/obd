import type { Page } from "@playwright/test";

/** Opens the vehicle profile picker on the Connect screen and chooses the profile with this name. */
export async function chooseProfile(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /Vehicle profile/ }).click();
  await page.locator(`[role="option"][data-profile="${name}"]`).click();
}
