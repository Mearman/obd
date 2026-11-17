import { expect, test } from "@playwright/test";
import { fits } from "./layout";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`states ${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("a bad link, a refused import and an empty guide fit and have large targets", async ({
        page,
      }) => {
        const base = `screenshots/states-${viewport.name}-${scheme}`;

        await page.goto("/#share=2.not-a-real-link");
        await expect(page.getByText(/This link cannot be opened/)).toBeVisible();
        await fits(page, "a link that cannot be opened");
        await page.screenshot({ path: `${base}-bad-link.png`, fullPage: true });

        await page.goto("/?screen=library");
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await page.getByLabel("Capture, saved scan, transcript or run file").setInputFiles({
          name: "notes.json",
          mimeType: "application/json",
          buffer: Buffer.from("{}"),
        });
        await expect(page.getByRole("alert").or(page.getByRole("status")).first()).toBeVisible();
        await fits(page, "a refused import");
        await page.screenshot({ path: `${base}-refused-import.png`, fullPage: true });

        await page.goto("/?screen=guide");
        await expect(
          page.getByRole("heading", { level: 1, name: /Guided recording/ }),
        ).toBeVisible();
        await fits(page, "the Guide with no adapter");
        await page.screenshot({ path: `${base}-guide-no-adapter.png`, fullPage: true });

        await page.goto("/");
        await page.getByRole("tab", { name: "Session" }).click();
        await expect(page.getByText("Not connected").first()).toBeVisible();
        await fits(page, "the disconnected Session");
        await page.screenshot({ path: `${base}-disconnected.png`, fullPage: true });
      });
    });
  }
}
