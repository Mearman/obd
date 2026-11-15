import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** The number of samples a test writes: enough to span several statements' worth of pages. */
const SAMPLES = 400;

/** Opens the app, waits for the service worker to control it and for the database to be ready. */
async function openApp(context: BrowserContext, baseURL: string | undefined): Promise<Page> {
  const page = await context.newPage();
  await page.goto(baseURL ?? "/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first load is not controlled by the service worker; a reload is.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.evaluate(async () => {
    await window.obdE2e;
  });
  return page;
}

/** Creates a stopped run holding `SAMPLES` samples through the page's real database worker. */
async function writeRun(page: Page, profile: string): Promise<string> {
  return page.evaluate(
    async ({ profile: name, count }) => {
      const database = await window.obdE2e;
      if (database === undefined) throw new Error("the end-to-end hook is missing");
      const run = await database.storage.createRun({
        profile: name,
        adapter: "simulator",
        startedAt: 1_000,
      });
      await database.storage.appendSamples(
        Array.from({ length: count }, (_unused, index) => ({
          runId: run.id,
          signal: "engine-speed",
          unit: "rpm",
          timestamp: 1_000 + index,
          value: 800 + index,
        })),
      );
      await database.storage.stopRun(run.id, 1_000 + count);
      return run.id;
    },
    { profile, count: SAMPLES },
  );
}

/** What the page's database holds for a run: the sample count, first and last values, and whether it is stopped. */
async function readRun(page: Page, runId: string) {
  return page.evaluate(async (id) => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    const samples = await database.storage.readSamples({ runId: id });
    const run = await database.storage.getRun(id);
    return {
      count: samples.length,
      first: samples[0]?.value,
      last: samples[samples.length - 1]?.value,
      stopped: run?.stoppedAt !== null && run?.stoppedAt !== undefined,
    };
  }, runId);
}

const EXPECTED = { count: SAMPLES, first: 800, last: 800 + SAMPLES - 1, stopped: true };

test("samples written through the worker survive a reload and an offline reload", async ({
  context,
  baseURL,
}) => {
  const page = await openApp(context, baseURL);

  const info = await page.evaluate(
    async () => (await (await window.obdE2e)?.control.info()) ?? null,
  );
  expect(info?.vfs).toBe("opfs-sahpool");
  expect(info?.sqliteVersion).toMatch(/^3\./);
  // The grant is the browser's decision; headless Chromium denies it. The worker must report it.
  expect(typeof info?.persisted === "boolean" || info?.persisted === null).toBe(true);

  const runId = await writeRun(page, "persistence");
  expect(await readRun(page, runId)).toEqual(EXPECTED);

  await page.reload();
  expect(await readRun(page, runId)).toEqual(EXPECTED);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect", level: 1 })).toBeVisible();
  expect(await readRun(page, runId)).toEqual(EXPECTED);
  await context.setOffline(false);
});

test("a second tab is told the database is in use and the first keeps working", async ({
  context,
  baseURL,
}) => {
  const first = await openApp(context, baseURL);
  const runId = await writeRun(first, "two-tabs");

  const second = await context.newPage();
  await second.goto(baseURL ?? "/");
  await expect(second.getByRole("alert")).toContainText("already open in another tab");
  const failure = await second.evaluate(async () => {
    try {
      await window.obdE2e;
      return null;
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  });
  expect(failure).toBe("DatabaseUnavailableError");

  // The first tab was not disturbed, and its data is intact.
  expect(await readRun(first, runId)).toEqual(EXPECTED);

  // Once the first tab closes, "Try again" in the second opens the same data.
  await first.close();
  await second.getByRole("button", { name: "Try again" }).click();
  await expect(second.getByRole("alert")).toBeHidden();
  expect(await readRun(second, runId)).toEqual(EXPECTED);
});

test("the database exports as a SQLite file and an import restores it", async ({
  context,
  baseURL,
}) => {
  const page = await openApp(context, baseURL);
  const kept = await writeRun(page, "exported");

  const exported = await page.evaluate(async () => {
    const bytes = await (await window.obdE2e)?.control.exportFile();
    return bytes === undefined ? [] : [...bytes];
  });
  expect(Buffer.from(exported.slice(0, 15)).toString("latin1")).toBe("SQLite format 3");

  const discarded = await writeRun(page, "written-after-export");
  expect(await readRun(page, discarded)).toEqual(EXPECTED);

  await page.evaluate(async (bytes) => {
    await (await window.obdE2e)?.control.importFile(new Uint8Array(bytes));
  }, exported);
  expect(await readRun(page, kept)).toEqual(EXPECTED);
  expect((await readRun(page, discarded)).count).toBe(0);

  // A file that is not an obd-read database is refused and leaves the data alone.
  const refusal = await page.evaluate(async () => {
    try {
      await (await window.obdE2e)?.control.importFile(new TextEncoder().encode("not a database"));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(refusal).toContain("not a SQLite database");
  expect(await readRun(page, kept)).toEqual(EXPECTED);

  // The import survives a reload: it was written to the file, not just held in memory.
  await page.reload();
  expect(await readRun(page, kept)).toEqual(EXPECTED);
});

test("the Settings screen exports and imports the database file", async ({ context, baseURL }) => {
  const page = await openApp(context, baseURL);
  const runId = await writeRun(page, "settings");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText(/SQLite 3\..* on opfs-sahpool/)).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export the database" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^obd-read-\d{4}-\d{2}-\d{2}\.sqlite$/);
  const path = await file.path();

  await writeRun(page, "after-export");
  await page.getByLabel("Database file").setInputFiles(path);
  await page.getByRole("button", { name: "Replace the stored data" }).click();
  await expect(page.getByText(/Replaced the stored data with/)).toBeVisible();

  const runs = await page.evaluate(
    async () => (await (await window.obdE2e)?.storage.listRuns())?.map((run) => run.profile) ?? [],
  );
  expect(runs).toEqual(["settings"]);
  expect(await readRun(page, runId)).toEqual(EXPECTED);
});
