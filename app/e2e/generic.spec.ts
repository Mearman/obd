import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./session";

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("a generic OBD-II session connects, scans, runs and keeps unit actions disabled", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Vehicle profile/ })).toContainText(
    "Generic OBD-II (no profile)",
  );
  await expect(page.getByText(/It cannot address one control unit/)).toBeVisible();
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();

  await openSection(page, "Read");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of Generic OBD-II/ })).toBeVisible();
  await expect(page.getByText(/VIN: SIMULATEDCAR00001/)).toBeVisible();
  const clearUnit = page.getByRole("button", { name: "Clear 7E8 codes" });
  await expect(clearUnit).toBeDisabled();
  await expect(clearUnit).toHaveAccessibleDescription(/needs a vehicle profile/);
  await openSection(page, "Advanced");
  for (const name of ["Write a value", "Run an actuator test"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(/needs a vehicle profile/);
  }
  await expect(
    page.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
  ).toBeEnabled();

  await openSection(page, "Live");
  await page.getByRole("button", { name: "Start collecting" }).click();
  await expect(
    page.getByRole("table", { name: /^Live values: / }).getByText("engine speed", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop collecting" }).click();

  await openScreen(page, "Library");
  // The scan above kept a report too, so read the run's own row.
  const run = page
    .getByRole("table", { name: "Library" })
    .getByRole("row")
    .filter({ has: page.getByText("Run", { exact: true }) });
  await expect(run.getByText("Generic OBD-II (no profile)")).toBeVisible();
  await expect(run.getByText("Stopped", { exact: true })).toBeVisible();
});
