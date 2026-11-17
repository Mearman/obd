import { expect, test } from "@playwright/test";
import { openSection } from "./session";
import { fits } from "./layout";

const VIEWPORTS = [
  { name: "narrow", width: 320, height: 640 },
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

      test("collects with a preset, stops, and fits with large targets", async ({ page }) => {
        const base = `screenshots/live-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Live");

        const engine = page.getByRole("button", { name: "Engine", exact: true });
        await expect(engine).toHaveAttribute("aria-pressed", "true");
        await fits(page, "the picker");
        await page.screenshot({ path: `${base}-picker.png`, fullPage: true });

        await engine.click();
        await page.getByRole("button", { name: "Start collecting" }).click();
        await expect(page.getByText("engine speed")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Search values" })).toBeVisible();
        await fits(page, "the readings");
        await page.screenshot({ path: `${base}-readings.png`, fullPage: true });

        await page.getByRole("button", { name: "Pin vehicle speed" }).click();
        await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
        await fits(page, "the pinned readings");

        await page.getByRole("button", { name: "Stop collecting" }).click();
        await expect(page.getByRole("button", { name: "Start collecting" })).toBeVisible();
        await fits(page, "the stopped screen");

        await page.getByRole("tab", { name: "Library" }).click();
        await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
        await expect(page.getByText("Stopping…")).toBeHidden();
        await fits(page, "the Library");
      });
    });
  }
}
