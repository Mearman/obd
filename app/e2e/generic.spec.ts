import { expect, test, type Page } from "@playwright/test";

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

  await openScreen(page, "Scan");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of Generic OBD-II/ })).toBeVisible();
  await expect(page.getByText(/VIN: SIMULATEDCAR00001/)).toBeVisible();
  for (const name of ["Write a value", "Run an actuator test", "Clear 7E8 codes"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(/needs a vehicle profile/);
  }
  await expect(
    page.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
  ).toBeEnabled();

  await openScreen(page, "Live");
  await page.getByRole("button", { name: "Start collecting" }).click();
  await expect(page.getByText("engine speed")).toBeVisible();
  await page.getByRole("button", { name: "Stop collecting" }).click();

  await openScreen(page, "Runs");
  const table = page.getByRole("table", { name: "Collection runs" });
  await expect(table.getByText("Generic OBD-II (no profile)")).toBeVisible();
  await expect(table.getByText("Stopped", { exact: true })).toBeVisible();
});
