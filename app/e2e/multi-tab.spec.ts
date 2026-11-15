import { expect, test, type Page } from "@playwright/test";
import { savedReports, shareLinkOfSimulatorScan } from "./share-links";

/** Creates a stopped run with a few samples through the page's database, wherever it is open, and returns what reading it back gives. */
async function writeAndReadRun(page: Page, profile: string) {
  return page.evaluate(async (name) => {
    const database = await window.obdE2e;
    if (database === undefined) throw new Error("the end-to-end hook is missing");
    const run = await database.storage.createRun({
      profile: name,
      adapter: "simulator",
      startedAt: 1,
    });
    await database.storage.appendSamples(
      [0, 1, 2].map((index) => ({
        runId: run.id,
        signal: "engine-speed",
        unit: "rpm",
        timestamp: 1 + index,
        value: 800 + index,
      })),
    );
    await database.storage.stopRun(run.id, 10);
    const stored = await database.storage.getRun(run.id);
    return {
      profile: stored?.profile,
      stopped: stored?.stoppedAt,
      samples: (await database.storage.readSamples({ runId: run.id })).length,
    };
  }, profile);
}

test("links opened in several tabs at once are all saved, and the last tab keeps working after the first closes", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const senderPage = await sender.newPage();
  const redacted = await shareLinkOfSimulatorScan(senderPage, true);
  const unredacted = await shareLinkOfSimulatorScan(senderPage, false);
  expect(redacted).not.toBe(unredacted);
  await sender.close();

  const receiver = await browser.newContext();
  const first = await receiver.newPage();
  const second = await receiver.newPage();
  await Promise.all([first.goto(redacted), second.goto(unredacted)]);
  for (const page of [first, second]) {
    await expect(page.getByRole("heading", { name: "Shared data" })).toBeVisible();
    await expect(page.getByText("Saved to this device, marked as shared.")).toBeVisible();
    await expect(page.getByRole("alert")).toBeHidden();
  }
  // Both tabs read the same database, which holds both links.
  expect(await savedReports(first)).toHaveLength(2);
  expect(await savedReports(second)).toHaveLength(2);

  await first.close();
  // The second tab now opens the database itself; it reads what was there and writes more.
  expect(await savedReports(second)).toHaveLength(2);
  expect(await writeAndReadRun(second, "after-handover")).toEqual({
    profile: "after-handover",
    stopped: 10,
    samples: 3,
  });

  // A tab opened later uses the second tab's database.
  const third = await receiver.newPage();
  await third.goto("/");
  await expect(third.getByRole("tablist")).toBeVisible();
  expect(await savedReports(third)).toHaveLength(2);
  expect(await writeAndReadRun(third, "from-the-third-tab")).toMatchObject({ samples: 3 });
  await receiver.close();
});

test("a run saved in one tab appears in another tab's Library without a reload", async ({
  context,
}) => {
  const viewer = await context.newPage();
  await viewer.goto("/");
  await viewer.getByRole("tab", { name: "Library" }).click();
  await expect(viewer.getByText("generic-from-elsewhere")).toBeHidden();

  const writer = await context.newPage();
  await writer.goto("/");
  await writeAndReadRun(writer, "generic-from-elsewhere");
  await expect(viewer.getByText("generic-from-elsewhere")).toBeVisible();
});

test("a run another tab is collecting is not resumed here, and resumes once that tab has gone and after a reload", async ({
  context,
}) => {
  const runs = (page: Page) => page.getByRole("table", { name: "Library" });
  const collector = await context.newPage();
  await collector.goto("/");
  await collector.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(collector.getByText("Connected to Simulator")).toBeVisible();
  await collector.getByRole("tab", { name: "Live" }).click();
  await collector.getByRole("button", { name: "Start collecting" }).click();
  await expect(collector.getByText("Collecting", { exact: true })).toBeVisible();

  // A second tab sees the open run but neither resumes it on load nor on request.
  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("tab", { name: "Library" }).click();
  await expect(runs(other).getByText("Open", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Resume" }).click();
  await expect(other.getByRole("alert")).toContainText("being collected in another tab");
  await expect(runs(other).getByText("Collecting", { exact: true })).toBeHidden();
  await collector.getByRole("tab", { name: "Library" }).click();
  await expect(runs(collector).getByText("Collecting", { exact: true })).toBeVisible();

  // Once the collecting tab has gone, the run resumes here and keeps collecting after a reload.
  await collector.close();
  await other.getByRole("button", { name: "Resume" }).click();
  await expect(runs(other).getByText("Collecting", { exact: true })).toBeVisible();
  await other.reload();
  await other.getByRole("tab", { name: "Library" }).click();
  await expect(runs(other).getByText("Collecting", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Stop" }).click();
  await expect(runs(other).getByText("Stopped", { exact: true })).toBeVisible();
});
