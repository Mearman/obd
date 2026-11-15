import { expect, test, type BrowserContext } from "@playwright/test";
import { savedReports, shareLinkOfSimulatorScan } from "./share-links";

const VIN = "SIMULATEDCAR00001";

/** Turns the setting "Save received links automatically" off in every page of `context`, as the Settings screen stores it. */
async function turnAutoSaveOff(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("obd-read.auto-save-shared", "off");
  });
}

test("a link from a simulator scan opens as read-only shared data in a fresh context and is saved once by default", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
  await sender.close();

  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Shared data" })).toBeVisible();
  await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Saved" })).toBeDisabled();
  expect(page.url()).toContain("#share=2.");
  const [stored, ...others] = await savedReports(page);
  expect(others).toEqual([]);
  expect(stored?.summary).toMatchObject({ adapter: "shared://link", origin: "shared" });

  // Opening the same link again in this browser saves nothing more.
  await page.reload();
  await expect(page.getByText(/saved to this device earlier/)).toBeVisible();
  expect(await savedReports(page)).toHaveLength(1);

  await page.getByRole("button", { name: "Dismiss" }).click();
  expect(page.url()).not.toContain("share=");
  await expect(page.getByRole("tablist")).toBeVisible();
  await receiver.close();
});

test("with automatic saving off a link is stored only on Save", async ({ browser }) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
  await sender.close();

  const receiver = await browser.newContext();
  await turnAutoSaveOff(receiver);
  const page = await receiver.newPage();
  await page.goto(link);
  await page.evaluate(async () => {
    await window.obdE2e;
  });

  await expect(page.getByRole("heading", { name: "Shared data" })).toBeVisible();
  await expect(page.getByText("From a link, not your adapter")).toBeVisible();
  await expect(page.getByRole("table", { name: "Shared scan" })).toBeVisible();
  const identification = page.getByRole("table", { name: "Shared identification" });
  await expect(identification.getByText("removed").first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(VIN);
  expect(page.url()).toContain("#share=2.");
  await expect(page.getByRole("tablist")).toHaveCount(0);

  // Nothing is written until the user presses Save.
  expect(await savedReports(page)).toEqual([]);

  await page.getByRole("button", { name: "Save this scan" }).click();
  await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
  expect(page.url()).toContain("#share=2.");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Saved the shared scan", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("share=");
  await expect(page.getByRole("tablist")).toBeVisible();
  const [stored, ...others] = await savedReports(page);
  expect(others).toEqual([]);
  expect(stored?.summary).toMatchObject({
    adapter: "shared://link",
    label: "Shared scan",
    origin: "shared",
  });
  expect(stored?.saved?.report).toMatchObject({ origin: "shared", tool: "obd-read" });
  expect(JSON.stringify(stored?.saved?.report)).not.toContain(VIN);
  await page.getByRole("tab", { name: "Library" }).click();
  const saved = page.getByRole("table", { name: "Library" });
  await expect(saved.getByText("Shared", { exact: true })).toBeVisible();
  await receiver.close();
});

test("a link from a generic OBD-II scan opens as a read-only report without the VIN", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const senderPage = await sender.newPage();
  await senderPage.goto("/");
  await senderPage.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(senderPage.getByText("Connected to Simulator")).toBeVisible();
  await senderPage.getByRole("tab", { name: "Scan" }).click();
  await senderPage.getByRole("button", { name: "Start scan" }).click();
  await expect(senderPage.getByText(/VIN: SIMULATEDCAR00001/)).toBeVisible();
  await senderPage.getByRole("button", { name: "Share scan" }).click();
  const dialog = senderPage.getByRole("dialog", { name: "Share this scan" });
  await expect(dialog.getByText(/characters$/)).toBeVisible();
  const link = await dialog.getByLabel("Link", { exact: true }).innerText();
  await sender.close();

  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Shared data" })).toBeVisible();
  await expect(page.getByText("From a link, not your adapter")).toBeVisible();
  await expect(page.getByText("VIN: removed")).toBeVisible();
  await expect(page.getByRole("table", { name: "Live values at the scan" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(VIN);
  await expect(page.getByRole("button", { name: "Save this scan" })).toHaveCount(0);
  await receiver.close();
});

test("with automatic saving off, Dismiss writes nothing and clears the address", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), false);
  await sender.close();

  const receiver = await browser.newContext();
  await turnAutoSaveOff(receiver);
  const page = await receiver.newPage();
  await page.goto(link);
  await page.evaluate(async () => {
    await window.obdE2e;
  });
  await expect(
    page.getByRole("table", { name: "Shared identification" }).getByText(VIN).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  expect(page.url()).not.toContain("share=");
  expect(await savedReports(page)).toEqual([]);
  await receiver.close();
});

test("the service worker serves the shell for a share link while offline", async ({ browser }) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
  await sender.close();

  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await receiver.setOffline(true);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Shared data" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Shared scan" })).toBeVisible();
  await receiver.close();
});
