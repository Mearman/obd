import { chooseProfile } from "./profile";
import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "narrow phone", width: 320, height: 640 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

/** The smallest touch target, in CSS pixels. */
const MIN_TARGET = 44;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Captures the simulated W211 and leaves the viewer open on it. */
async function openViewer(page: Page): Promise<void> {
  await page.goto("/");
  await chooseProfile(page, "mercedes-w211");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await page.getByRole("tab", { name: "Scan" }).click();
  await page.getByRole("button", { name: "Capture everything" }).click();
  await expect(page.getByRole("status", { name: "Decoding summary" })).toHaveText(
    /with mercedes-w211/,
  );
  await expect(page.getByRole("slider", { name: "Playback position" })).toBeVisible();
}

test("playback scrubs and plays a simulator capture and never sends anything", async ({ page }) => {
  const sent: string[] = [];
  page.on("websocket", (socket) => sent.push(socket.url()));
  await openViewer(page);
  const slider = page.getByRole("slider", { name: "Playback position" });
  const summary = page.getByRole("status", { name: "Decoding summary" });
  const total = Number(await slider.getAttribute("max"));
  expect(total).toBeGreaterThan(10);
  await expect(slider).toHaveValue(String(total));
  await expect(page.getByText(`All ${String(total)} exchanges are shown.`)).toBeVisible();
  const whole = await summary.innerText();

  // Home goes to before the first exchange; the tables show nothing yet.
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveValue("0");
  await expect(summary).toHaveText(/of 0 exchanges/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("3");
  await expect(summary).toHaveText(/of 3 exchanges/);
  await expect(page.getByRole("status").filter({ hasText: /^Exchange 3 of/ })).toBeVisible();

  // Play at 4x with Space until the cursor has moved on, pause, then play to the end.
  await page.getByRole("button", { name: "4 times speed" }).click();
  await slider.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(5);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /^(Play|Replay)$/ })).toBeVisible();
  await page.getByRole("button", { name: /^(Play|Replay)$/ }).click();
  await expect(slider).toHaveValue(String(total), { timeout: 30_000 });

  // At the end it is today's view again.
  await expect(page.getByText(`All ${String(total)} exchanges are shown.`)).toBeVisible();
  await expect(summary).toHaveText(whole);
  await page.getByRole("button", { name: "Step back" }).click();
  await expect(page.getByRole("switch", { name: "Show everything" })).not.toBeChecked();
  await page.getByRole("switch", { name: "Show everything" }).click();
  await expect(summary).toHaveText(whole);

  expect(sent).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("the playback panel fits and its controls are large enough", async ({ page }) => {
        await openViewer(page);
        const slider = page.getByRole("slider", { name: "Playback position" });
        await slider.focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await expect(slider).toHaveValue("1");

        expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(0);
        const panel = page.getByRole("region", { name: "Playback" });
        const small = await panel.locator("button, input").evaluateAll(
          (elements, min) =>
            elements
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => ({
                name: element.getAttribute("aria-label") ?? element.textContent,
                box: element.getBoundingClientRect(),
              }))
              .filter(({ box }) => box.width < min || box.height < min)
              .map(
                ({ name, box }) =>
                  `${name} ${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
              ),
          MIN_TARGET,
        );
        expect(small).toEqual([]);
        const box = await panel.boundingBox();
        expect(box?.width ?? Infinity).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({
          path: `screenshots/playback-${viewport.name.replace(" ", "-")}-${scheme}.png`,
          fullPage: true,
        });
      });
    });
  }
}
