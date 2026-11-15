import { expect, test, type Page } from "@playwright/test";

const VIN = "SIMULATEDCAR00001";

/** What the page's real database holds as saved scan reports. */
async function savedReports(page: Page) {
  return page.evaluate(async () => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    const summaries = await database.storage.listScanReports({});
    return Promise.all(
      summaries.map(async (summary) => ({
        summary,
        saved: await database.storage.getScanReport(summary.id),
      })),
    );
  });
}

/** Scans the simulated Volkswagen on `page` and returns the link its Share dialog makes. */
async function shareLinkOfSimulatorScan(page: Page, redact: boolean): Promise<string> {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Vehicle profile" }).click();
  await page.getByRole("option", { name: /vag-mqb/ }).click();
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await page.getByRole("tab", { name: "Scan" }).click();
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of vag-mqb/ })).toBeVisible();
  await page.getByRole("button", { name: "Share scan" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this scan" });
  const toggle = dialog.getByRole("switch", { name: /remove the vin/i });
  await expect(toggle).toBeChecked();
  if (!redact) await toggle.click();
  await expect(dialog.getByText(/characters$/)).toBeVisible();
  const link = await dialog.getByLabel("Link", { exact: true }).innerText();
  expect(link).toContain("#share=1.");
  return link;
}

test("a link from a simulator scan opens as read-only shared data in a fresh context, and is stored only on Save", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
  await sender.close();

  const receiver = await browser.newContext();
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
  expect(page.url()).toContain("#share=1.");
  await expect(page.getByRole("tablist")).toHaveCount(0);

  // Nothing is written until the user presses Save.
  expect(await savedReports(page)).toEqual([]);

  await page.getByRole("button", { name: "Save this scan" }).click();
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
  await page.getByRole("tab", { name: "Scan" }).click();
  const saved = page.getByRole("table", { name: "Saved reports" });
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

test("Dismiss writes nothing and clears the address", async ({ browser }) => {
  const sender = await browser.newContext();
  const link = await shareLinkOfSimulatorScan(await sender.newPage(), false);
  await sender.close();

  const receiver = await browser.newContext();
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
