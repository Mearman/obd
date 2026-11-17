import { chooseProfile } from "./profile";
import { openSection } from "./session";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { canonicalJson, decodeShare, fragmentOfLink } from "obd-read";
import { streamShareCodec } from "obd-read/web";

/** The ASCII bytes of the simulator's invented VIN, as a capture's raw replies spell it. */
const VIN_BYTES = Array.from("SIMULATEDCAR00001", (character) =>
  character.charCodeAt(0).toString(16).toUpperCase(),
).join("");

/** The ids of the captures the page's real database holds. */
async function storedCaptures(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    return (await database.storage.listCaptures({})).map((capture) => capture.id);
  });
}

async function expectSummary(page: Page, pattern: RegExp): Promise<void> {
  await expect(page.getByRole("status", { name: "Decoding summary" })).toHaveText(pattern);
}

/** Captures the simulated W211 on `page` and returns the raw capture link its Share dialog makes. */
async function rawCaptureLink(page: Page, redact: boolean): Promise<string> {
  await page.goto("/");
  await chooseProfile(page, "mercedes-w211");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Capture everything" }).click();
  await expectSummary(page, /with mercedes-w211/);
  await page.getByRole("button", { name: "Share the raw capture" }).click();
  const dialog = page.getByRole("dialog", { name: "Share the raw capture" });
  const toggle = dialog.getByRole("switch", { name: /overwrite the vin/i });
  await expect(toggle).toBeChecked();
  if (!redact) await toggle.click();
  await expect(dialog.getByText(/characters$/)).toBeVisible();
  const link = await dialog.getByLabel("Link", { exact: true }).innerText();
  expect(link).toContain("#share=2.");
  return link;
}

/** Turns the setting "Save received links automatically" off in every page of `context`, as the Settings screen stores it. */
async function turnAutoSaveOff(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("obd-read.auto-save-shared", "off");
  });
}

/** The capture stored under `id` in the page's real database, as canonical JSON. */
async function storedCaptureJson(page: Page, id: string): Promise<string> {
  const capture = await page.evaluate(async (wanted) => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    return database.storage.getCapture(wanted);
  }, id);
  if (capture === undefined) throw new Error(`no capture ${id}`);
  return canonicalJson(capture);
}

test("a packed raw capture link opens in a fresh context as exactly the capture it carries", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await rawCaptureLink(await sender.newPage(), false);
  await sender.close();
  const fragment = fragmentOfLink(link);
  if (fragment === undefined) throw new Error("no share fragment");
  const carried = await decodeShare(fragment, streamShareCodec);
  if (!carried.ok || carried.value.kind !== "capture") throw new Error("not a capture link");
  const { capture } = carried.value.data;
  expect(capture.exchanges.length).toBeGreaterThan(0);

  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  await page.goto(link);
  await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
  expect(await storedCaptures(page)).toEqual([capture.id]);
  expect(await storedCaptureJson(page, capture.id)).toBe(canonicalJson(capture));
  await receiver.close();
});

test("a raw capture link is saved once on opening by default", async ({ browser }) => {
  const sender = await browser.newContext();
  const link = await rawCaptureLink(await sender.newPage(), true);
  await sender.close();

  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  await page.goto(link);
  await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
  expect(await storedCaptures(page)).toHaveLength(1);
  // Once its capture is stored here, the same link opens that stored item, marked as shared.
  await page.reload();
  await expectSummary(page, /with /);
  await expect(page.getByRole("heading", { name: "Shared data" })).toHaveCount(0);
  await expect(page.getByText("Shared", { exact: true })).toBeVisible();
  expect(await storedCaptures(page)).toHaveLength(1);
  await receiver.close();
});

test("with automatic saving off a raw capture link re-decodes under the chosen profile in a fresh context and is stored only on Save", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await rawCaptureLink(await sender.newPage(), true);
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

  // The selector opens on the profile the capture was read with, which this app ships.
  await expectSummary(page, /Decoded \d+ Left raw 0 of \d+ exchanges with mercedes-w211/);
  await expect(page.getByRole("table", { name: "Units decoded with mercedes-w211" })).toBeVisible();

  await chooseProfile(page, "vag-mqb", "Decode with");
  await expectSummary(page, /Left raw [1-9]\d* of \d+ exchanges with vag-mqb/);
  await expect(page.getByRole("table", { name: "Exchanges vag-mqb leaves raw" })).toBeVisible();

  await chooseProfile(page, "", "Decode with");
  await expectSummary(page, /Left raw [1-9]\d* of \d+ exchanges with Generic OBD-II/);
  await expect(page.getByText("VIN: *****************").first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(VIN_BYTES);

  // Choosing profiles wrote nothing.
  expect(await storedCaptures(page)).toEqual([]);

  await page.getByRole("button", { name: "Save this capture" }).click();
  await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
  expect(page.url()).toContain("#share=2.");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Saved the shared capture", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("share=");
  await expect(page.getByRole("tablist")).toBeVisible();
  expect(await storedCaptures(page)).toHaveLength(1);
  await page.getByRole("tab", { name: "Library" }).click();
  // The saved item is open in the Library, in place of the list.
  await page.getByRole("button", { name: "Close" }).first().click();
  const listed = page.getByRole("table", { name: "Library" });
  await expect(listed.getByText("Shared", { exact: true })).toBeVisible();
  await receiver.close();
});

test("with automatic saving off, Dismiss on a raw capture link writes nothing", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const link = await rawCaptureLink(await sender.newPage(), false);
  await sender.close();

  const receiver = await browser.newContext();
  await turnAutoSaveOff(receiver);
  const page = await receiver.newPage();
  await page.goto(link);
  await page.evaluate(async () => {
    await window.obdE2e;
  });
  await expectSummary(page, /with mercedes-w211/);
  await page.getByRole("button", { name: "Dismiss" }).click();
  expect(page.url()).not.toContain("share=");
  expect(await storedCaptures(page)).toEqual([]);
  await receiver.close();
});

test("an open item's address is its sharing link: the same link opens the item where it is stored and as shared data elsewhere", async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const page = await owner.newPage();
  await page.goto("/");
  await chooseProfile(page, "mercedes-w211");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Capture everything" }).click();
  await expectSummary(page, /with mercedes-w211/);

  // The address bar already holds the link the Share dialog would make, with the VIN overwritten.
  await expect.poll(() => fragmentOfLink(page.url())).toMatch(/^share=2\./);
  const address = page.url();
  const fragment = fragmentOfLink(address) ?? "";
  const decoded = await decodeShare(fragment, streamShareCodec);
  expect(decoded.ok && JSON.stringify(decoded.value)).not.toContain(VIN_BYTES);

  // Where the capture is stored, the link opens that item, not a read-only copy.
  const again = await owner.newPage();
  await again.goto(address);
  await expectSummary(again, /with mercedes-w211/);
  await expect(again.getByRole("heading", { name: "Shared data" })).toHaveCount(0);

  // Anywhere else it is the shared viewer.
  const stranger = await browser.newContext();
  const elsewhere = await stranger.newPage();
  await elsewhere.goto(address);
  await expect(elsewhere.getByRole("heading", { name: "Shared data" })).toBeVisible();

  // Closing the item takes the link out of the address.
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect.poll(() => fragmentOfLink(page.url())).toBeUndefined();
  await stranger.close();
  await owner.close();
});
