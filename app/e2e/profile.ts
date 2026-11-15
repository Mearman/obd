import type { Page } from "@playwright/test";

/** Opens a profile picker by its label and chooses the profile with this name; an empty name is Generic OBD-II. */
export async function chooseProfile(
  page: Page,
  name: string,
  label = "Vehicle profile",
): Promise<void> {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.locator(`[role="option"][data-profile="${name}"]`).click();
}
