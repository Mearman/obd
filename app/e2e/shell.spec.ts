import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./session";
import { fits } from "./layout";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

const SCREENS = ["Session", "Library", "Settings"] as const;

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("every screen fits, has large targets and is captured", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();

        for (const name of SCREENS) {
          await openScreen(page, name);
          if (name === "Session") {
            await page.getByRole("button", { name: "Start scan" }).click();
            await expect(page.getByRole("table", { name: /^Scan of / })).toBeVisible();
          }

          await fits(page, name);

          const background = await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          );
          expect(background).not.toBe("rgba(0, 0, 0, 0)");

          // The viewport shot shows where the fixed navigation really sits; the full-page shot
          // shows everything below the fold.
          const base = `screenshots/${viewport.name}-${scheme}-${name.toLowerCase()}`;
          await page.screenshot({ path: `${base}.png` });
          await page.screenshot({ path: `${base}-full.png`, fullPage: true });
        }
      });
    });
  }
}

test("the manual theme choice overrides the system scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
});

test("the shell loads offline from the service worker and makes no outside requests", async ({
  page,
  context,
  baseURL,
}) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    if (baseURL !== undefined && !request.url().startsWith(baseURL)) outside.push(request.url());
  });

  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first load is not controlled by the worker; a reload is.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of/ })).toBeVisible();

  expect(outside).toEqual([]);
  await context.setOffline(false);
});

test("the web app manifest makes it installable", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).not.toBeNull();
  const manifest: unknown = await (
    await request.get(new URL(href ?? "", page.url()).toString())
  ).json();
  expect(manifest).toMatchObject({ display: "standalone", name: "obd-read" });
});
