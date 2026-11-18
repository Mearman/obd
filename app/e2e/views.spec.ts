import { expect, test } from "@playwright/test";
import { openSection } from "./session";
import { shareLinkOfSimulatorScan } from "./share-links";
import { fits } from "./layout";

const VIEWPORTS = [
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

      test("the capture viewer and a shared link fit and have large targets", async ({
        page,
        browser,
      }) => {
        const base = `screenshots/views-${viewport.name}-${scheme}`;

        await page.goto("/?screen=library");
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await fits(page, "the empty Library");
        await page.screenshot({ path: `${base}-library-empty.png` });

        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Read");
        await page.getByRole("button", { name: "Capture everything" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Share the capture" })).toBeVisible();
        await fits(page, "the capture viewer");
        await page.screenshot({ path: `${base}-capture-full.png`, fullPage: true });

        await page.getByRole("button", { name: "Share the capture" }).click();
        await page.getByRole("menuitem", { name: "The raw capture" }).click();
        await expect(page.getByRole("dialog", { name: "Share the raw capture" })).toBeVisible();
        await fits(page, "the share dialog");
        await page.screenshot({ path: `${base}-share-dialog.png` });

        const sender = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const link = await shareLinkOfSimulatorScan(await sender.newPage(), true);
        await sender.close();
        const receiver = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const shared = await receiver.newPage();
        await shared.goto(link);
        await expect(shared.getByRole("heading", { name: "Shared data" })).toBeVisible();
        await fits(shared, "the shared viewer");
        await shared.screenshot({ path: `${base}-shared-full.png`, fullPage: true });
        await receiver.close();
      });
    });
  }
}

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`dialogs ${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("a run's menu and dialogs, and the problem report, fit and have large targets", async ({
        page,
      }) => {
        const base = `screenshots/dialogs-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Live");
        await page.getByRole("button", { name: "Start collecting" }).click();
        await expect(page.getByRole("button", { name: "Stop collecting" })).toBeVisible();
        await page.getByRole("button", { name: "Stop collecting" }).click();
        await page.getByRole("tab", { name: "Library" }).click();
        await expect(page.getByRole("table", { name: "Library" })).toBeVisible();

        await fits(page, "the Library with a run");
        await page.getByRole("button", { name: /^Export run/ }).click();
        await expect(page.getByRole("menuitem", { name: "CSV" })).toBeVisible();
        await fits(page, "the Export menu");
        await page.screenshot({ path: `${base}-export-menu.png` });
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: /^Fault codes of run/ }).click();
        await expect(page.getByRole("dialog", { name: "Fault codes" })).toBeVisible();
        await fits(page, "the fault codes dialog");
        await page.screenshot({ path: `${base}-fault-codes.png` });
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Share", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Share this run's summary" })).toBeVisible();
        await fits(page, "the run share dialog");
        await page.screenshot({ path: `${base}-run-share.png` });
      });
    });
  }
}

/** The VIN the generic simulator reports. */
const SIMULATED_VIN = "SIMULATEDCAR00001";

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`vehicles ${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("the Library grouped and filtered by vehicle fits, and shares items from two groups", async ({
        page,
      }) => {
        const base = `screenshots/vehicles-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        const collect = async (): Promise<void> => {
          await openSection(page, "Live");
          await page.getByRole("button", { name: "Start collecting" }).click();
          await page.getByRole("button", { name: "Stop collecting" }).click();
          await expect(page.getByRole("button", { name: "Start collecting" })).toBeVisible();
        };
        // A run before the connection has read a VIN, then a scan that reads it and a run after.
        await collect();
        await openSection(page, "Read");
        await page.getByRole("button", { name: "Start scan" }).click();
        await expect(page.getByText(`VIN: ${SIMULATED_VIN}`)).toBeVisible();
        await collect();

        await page.goto("/?screen=library&group=vehicle");
        const known = page.getByRole("table", { name: `Library, ${SIMULATED_VIN}` });
        const unknown = page.getByRole("table", { name: "Library, Unknown vehicle" });
        await expect(page.getByRole("button", { name: `${SIMULATED_VIN} (2)` })).toBeVisible();
        await expect(page.getByRole("button", { name: "Unknown vehicle (1)" })).toBeVisible();
        await expect(known.getByRole("checkbox")).toHaveCount(2);
        await fits(page, "the Library grouped by vehicle");
        await page.screenshot({ path: `${base}-library-grouped.png`, fullPage: true });

        await known.getByRole("checkbox").first().check();
        await unknown.getByRole("checkbox").first().check();
        await page.getByRole("button", { name: "Share selected (2)" }).click();
        await expect(page.getByRole("dialog", { name: "Share 2 results" })).toBeVisible();
        await fits(page, "the share dialog of two vehicles' items");
        await page.keyboard.press("Escape");

        await page.getByRole("combobox", { name: "Vehicle" }).click();
        await page.getByRole("option", { name: "Unknown vehicle" }).click();
        await expect(page).toHaveURL(/vehicle=unknown/);
        await expect(page.getByRole("button", { name: `${SIMULATED_VIN} (2)` })).toHaveCount(0);
        await expect(unknown.getByRole("checkbox")).toHaveCount(1);
        // The selection outlives the filter that hides one of its items.
        await expect(page.getByRole("button", { name: "Share selected (2)" })).toBeVisible();
        await fits(page, "the Library filtered to the unknown vehicle");
        await page.screenshot({ path: `${base}-library-unknown.png`, fullPage: true });
      });

      test("a plate given on the Session screen shows in the Library and the Vehicles card, and both fit", async ({
        page,
      }) => {
        const base = `screenshots/plates-${viewport.name}-${scheme}`;
        await page.goto("/");
        await page.getByRole("button", { name: /connect with the simulator/i }).click();
        await expect(page.getByText("Connected to Simulator")).toBeVisible();
        await openSection(page, "Connection");
        await page.getByRole("textbox", { name: "Number plate (optional)" }).fill("ab12-cde");
        await page.getByRole("button", { name: "Keep plate" }).click();
        await expect(page.getByText("AB12 CDE is kept with what you save")).toBeVisible();
        await fits(page, "the connection with a plate");
        await page.screenshot({ path: `${base}-session-plate.png` });

        await openSection(page, "Read");
        await page.getByRole("button", { name: "Start scan" }).click();
        await expect(page.getByText(`VIN: ${SIMULATED_VIN}`)).toBeVisible();

        await page.goto("/?screen=library&group=vehicle&q=ab12%20cde");
        await expect(
          page.getByRole("button", { name: `${SIMULATED_VIN} (AB12 CDE) (1)` }),
        ).toBeVisible();
        await fits(page, "the Library found by plate");
        await page.screenshot({ path: `${base}-library-plate.png`, fullPage: true });

        await page.goto("/?screen=settings");
        const vehicles = page.getByRole("table", { name: "Vehicles" });
        await expect(vehicles.getByText(SIMULATED_VIN)).toBeVisible();
        await expect(vehicles.getByText("AB12 CDE", { exact: true })).toBeVisible();
        await fits(page, "the Vehicles card");
        await page.getByRole("button", { name: `Edit ${SIMULATED_VIN}` }).click();
        await page.getByRole("menuitem", { name: "Add a plate" }).click();
        await expect(
          page.getByRole("dialog", { name: `Add a plate to ${SIMULATED_VIN}` }),
        ).toBeVisible();
        await fits(page, "the add-a-plate dialog");
        await page.screenshot({ path: `${base}-add-plate.png` });
        await page.getByRole("textbox", { name: "Number plate" }).fill("XY65 ZZZ");
        await page.getByLabel("On it from (UTC)").fill("2030-01-01");
        await page.getByRole("button", { name: "Add the plate" }).click();
        await expect(page.getByText("XY65 ZZZ from 2030-01-01, still on it")).toBeVisible();
        await expect(page.getByText("AB12 CDE from", { exact: false })).toContainText(
          "until 2029-12-31",
        );
        // The plate is still AB12 CDE today, as plateAt reads it.
        await expect(vehicles.getByText("AB12 CDE", { exact: true })).toBeVisible();

        // The new plate was a mistake: its period is changed, then it is deleted.
        await page.getByRole("button", { name: `Edit ${SIMULATED_VIN}` }).click();
        await page.getByRole("menuitem", { name: /^Change XY65 ZZZ/ }).click();
        await page.getByLabel("First day on this car (UTC)").fill("2031-01-01");
        await fits(page, "the change-a-plate dialog");
        await page.screenshot({ path: `${base}-change-plate.png` });
        await page.getByRole("button", { name: "Keep the period" }).click();
        await expect(page.getByText("XY65 ZZZ from 2031-01-01, still on it")).toBeVisible();
        await page.getByRole("button", { name: `Edit ${SIMULATED_VIN}` }).click();
        await page.getByRole("menuitem", { name: /^Change XY65 ZZZ/ }).click();
        await page.getByRole("button", { name: "Delete this plate" }).click();
        await expect(page.getByText("XY65 ZZZ", { exact: false })).toHaveCount(0);

        // A car whose units report no VIN is added by hand with its plate.
        await page.getByRole("button", { name: "Add a vehicle" }).click();
        await page.getByRole("textbox", { name: "Name" }).fill("W211");
        await page.getByRole("textbox", { name: "Number plate" }).fill("w211 plt");
        await fits(page, "the add-a-vehicle dialog");
        await page.getByRole("button", { name: "Add the vehicle" }).click();
        await expect(vehicles.getByText("W211", { exact: true })).toBeVisible();
        await expect(
          vehicles.getByText("W211 PLT from an unknown date, still on it"),
        ).toBeVisible();
        await fits(page, "the Vehicles card with a car added by hand");
        await page.screenshot({ path: `${base}-vehicles.png`, fullPage: true });
      });

      test("two records of one car merge from the Vehicles card, and the dialog and the result fit", async ({
        page,
      }) => {
        const base = `screenshots/merge-${viewport.name}-${scheme}`;
        await page.goto("/?screen=settings");
        const vehicles = page.getByRole("table", { name: "Vehicles" });

        // A car with a VIN, and a car known only by a plate it carried until the end of 2019.
        await page.getByRole("button", { name: "Add a vehicle" }).click();
        await page.getByRole("textbox", { name: "Name" }).fill("Estate");
        await page.getByRole("textbox", { name: "VIN (optional)" }).fill("WDB2110200A000001");
        await page.getByRole("textbox", { name: "Number plate" }).fill("ab12 cde");
        await page.getByLabel("Plate on it from (UTC)").fill("2020-01-01");
        await page.getByRole("button", { name: "Add the vehicle" }).click();
        await expect(vehicles.getByText("AB12 CDE from 2020-01-01, still on it")).toBeVisible();

        await page.getByRole("button", { name: "Add a vehicle" }).click();
        await page.getByRole("textbox", { name: "Name" }).fill("Blue estate");
        await page.getByRole("textbox", { name: "Number plate" }).fill("xy65 zzz");
        await page.getByLabel("Plate on it from (UTC)").fill("2015-01-01");
        await page.getByRole("button", { name: "Add the vehicle" }).click();
        await expect(vehicles.getByText("XY65 ZZZ from 2015-01-01, still on it")).toBeVisible();
        await page.getByRole("button", { name: "Edit Blue estate" }).click();
        await page.getByRole("menuitem", { name: "Plate XY65 ZZZ moved off" }).click();
        await page.getByLabel("Last day on this car (UTC)").fill("2019-12-31");
        await page.getByRole("button", { name: "End the plate" }).click();
        await expect(vehicles.getByText("XY65 ZZZ from 2015-01-01 until 2019-12-31")).toBeVisible();

        await page.getByRole("button", { name: "Edit Estate (WDB2110200A000001)" }).click();
        await page.getByRole("menuitem", { name: "Merge with another" }).click();
        const dialog = page.getByRole("dialog", { name: "Merge Estate (WDB2110200A000001)" });
        await expect(dialog).toBeVisible();
        await fits(page, "the merge dialog");
        await page.screenshot({ path: `${base}-merge-dialog.png` });
        await dialog.getByRole("combobox", { name: "The same car as" }).click();
        await page.getByRole("option", { name: "Blue estate" }).click();
        await fits(page, "the merge dialog with a car chosen");
        await dialog.getByRole("button", { name: "Merge into this one" }).click();
        await expect(dialog).toHaveCount(0);

        // One record is left, holding both plates with their periods.
        await expect(vehicles.getByRole("row")).toHaveCount(2);
        const plates = page.getByRole("list", {
          name: "Plates of Estate (WDB2110200A000001)",
        });
        await expect(plates.getByRole("listitem")).toHaveText([
          "AB12 CDE from 2020-01-01, still on it",
          "XY65 ZZZ from 2015-01-01 until 2019-12-31",
        ]);
        await expect(vehicles.getByRole("button", { name: "Edit Blue estate" })).toHaveCount(0);
        await fits(page, "the Vehicles card after a merge");
        await page.screenshot({ path: `${base}-vehicles.png`, fullPage: true });
      });
    });
  }
}
