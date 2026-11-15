import { expect, type Page } from "@playwright/test";

/** A section of the Session screen, by its title in the section navigation. */
export type SessionSection = "Connection" | "Read" | "Live" | "Advanced";

/** Shows the Session screen and expands one of its sections, leaving it expanded if it already is. */
export async function openSection(page: Page, name: SessionSection): Promise<void> {
  const tab = page.getByRole("tab", { name: "Session" });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const button = page
    .getByRole("navigation", { name: "Session sections" })
    .getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}
