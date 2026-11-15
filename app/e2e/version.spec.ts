import { expect, test } from "@playwright/test";
import { readReleasedVersion } from "../app-version";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** The smallest touch target, in CSS pixels. */
const MIN_TARGET = 44;

const version = readReleasedVersion();

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the top bar links the version to its release", async ({ page }) => {
      await page.goto("/");
      const link = page.getByRole("banner").getByRole("link", {
        name: `Release notes for version ${version}`,
      });
      await expect(link).toHaveText(`v${version}`);
      await expect(link).toHaveAttribute(
        "href",
        `https://github.com/Mearman/obd/releases/tag/v${version}`,
      );
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");

      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(box?.width).toBeGreaterThanOrEqual(MIN_TARGET);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });
  });
}
