import { chooseProfile } from "./profile";
import { openSection } from "./session";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { serveUnderPrefix } from "./static-server";

/** What the simulated Volkswagen reports as its VIN. */
const VIN = "SIMULATEDCAR00001";
const VIN_HEX = Buffer.from(VIN).toString("hex").toUpperCase();
const MAC = "00:1A:7D:DA:71:13";
const IPV4 = "192.168.4.22";
const FILE = "my-private-scan.json";

/** What a failing screen might carry: every kind of value the report must scrub. */
const MESSAGE = `bad read of ${VIN} (${VIN_HEX}) from adapter ${MAC} at ${IPV4} in ${FILE} frame 7E8 10 14 49 02 01 53 49 4D`;

async function connectAndScan(page: Page): Promise<void> {
  await page.goto("/");
  await chooseProfile(page, "vag-mqb");
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await openSection(page, "Read");
  await page.getByRole("button", { name: "Start scan" }).click();
  await expect(page.getByRole("table", { name: /Scan of vag-mqb/ })).toBeVisible();
}

async function failScan(page: Page): Promise<void> {
  await page.evaluate((message) => {
    window.obdE2eFail?.({ kind: "render", screen: "read", message });
  }, MESSAGE);
}

test("a failing screen is contained, and its report carries nothing from the session", async ({
  page,
  context,
}) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1")) outside.push(request.url());
  });
  await connectAndScan(page);
  await failScan(page);

  await expect(page.getByRole("heading", { name: "Read could not be shown" })).toBeVisible();
  // The rest of the app is still up: the shell, the connection and the other sections.
  await expect(page.getByRole("banner").getByText("Simulator", { exact: true })).toBeVisible();
  await openSection(page, "Live");
  await expect(page.getByRole("button", { name: "Start collecting" })).toBeVisible();
  await openSection(page, "Read");
  await expect(page.getByRole("heading", { name: "Read could not be shown" })).toBeVisible();

  await page.getByRole("button", { name: "Report this problem" }).click();
  const dialog = page.getByRole("dialog", { name: "Report this problem" });
  await expect(dialog.getByText(/Issues in this repository are public/)).toBeVisible();
  const report = (await dialog.getByLabel("Report text").textContent()) ?? "";

  for (const secret of [VIN, VIN_HEX, MAC, IPV4, FILE, "7E8 10 14", "49 02 01", "ELM327"]) {
    expect(report, `the report carries ${secret}`).not.toContain(secret);
  }
  expect(report).toContain("[vin]");
  expect(report).toContain("## Environment");
  expect(report).toMatch(/Browser: Chrom\w+ \d+ on /);
  expect(report).not.toMatch(/Mozilla|AppleWebKit|HeadlessChrome\/\d+\.\d+/);
  // What the app did, as kinds and outcomes.
  expect(report).toContain("connect simulator");
  expect(report).toContain("operation scan.run ok");
  expect(report).toContain("screen session");
  expect(report).toContain("error react on read");

  // The new-issue link carries the title, the same body and the bug label.
  const link = dialog.getByRole("link", { name: "Continue to GitHub" });
  const href = (await link.getAttribute("href")) ?? "";
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe("https://github.com/Mearman/obd/issues/new");
  expect(url.searchParams.get("title")).toMatch(/^App error on the Read section: Error: /);
  expect(url.searchParams.get("labels")).toBe("bug");
  expect(url.searchParams.get("body")).toBe(report);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(href.length).toBeLessThan(8000);

  // Following the link opens that address in a new tab with no opener. GitHub is stubbed, so
  // nothing leaves the machine and nothing is submitted.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }),
  );
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await popup.waitForURL(/github\.com\/Mearman\/obd\/issues\/new/);
  expect(popup.url()).toBe(href);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);

  // The app itself made no request outside its own origin.
  expect(outside).toEqual([]);
});

test("Try again recovers the screen once the cause is gone", async ({ page }) => {
  await connectAndScan(page);
  await failScan(page);
  await expect(page.getByRole("heading", { name: "Read could not be shown" })).toBeVisible();
  await page.evaluate(() => {
    window.obdE2eFail?.({ kind: "clear" });
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Start scan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Read could not be shown" })).toHaveCount(0);
});

test("an uncaught error and an unhandled rejection offer a report and leave the screen alone", async ({
  page,
}) => {
  await connectAndScan(page);
  await page.evaluate((message) => {
    window.obdE2eFail?.({ kind: "window", message });
  }, MESSAGE);
  await expect(page.getByText("Something went wrong")).toBeVisible();
  await expect(page.getByRole("table", { name: /Scan of vag-mqb/ })).toBeVisible();
  await page.getByRole("button", { name: "Report this problem" }).click();
  const dialog = page.getByRole("dialog", { name: "Report this problem" });
  const report = (await dialog.getByLabel("Report text").textContent()) ?? "";
  expect(report).toContain("outside any screen");
  for (const secret of [VIN, VIN_HEX, MAC, IPV4, FILE]) expect(report).not.toContain(secret);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.evaluate((message) => {
    window.obdE2eFail?.({ kind: "rejection", message });
  }, MESSAGE);
  await expect(page.getByText("Something went wrong")).toBeVisible();
  await page.getByRole("button", { name: "Report this problem" }).click();
  await expect(page.getByLabel("Report text")).toContainText(
    "in a task that nothing was waiting on",
  );
});

test.describe("the production build", () => {
  const OUT = resolve(import.meta.dirname, "..", "test-results", "production-build");

  test("has no way to force an error", async ({ page }) => {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "VITE_OBD_E2E"),
    );
    execFileSync("pnpm", ["exec", "vite", "build", "--outDir", OUT, "--emptyOutDir"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: environment,
      stdio: "pipe",
    });
    const scripts = readdirSync(join(OUT, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(OUT, "assets", name), "utf8"));
    // The report interface is in the build, so the absence below means something.
    expect(scripts.some((source) => source.includes("Report this problem"))).toBe(true);
    for (const source of scripts) {
      expect(source).not.toContain("obdE2eFail");
      expect(source).not.toContain("obdE2e");
    }

    const server = await serveUnderPrefix(OUT, "/");
    try {
      await page.goto(`${server.origin}/`);
      await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();
      expect(await page.evaluate(() => "obdE2eFail" in window || "obdE2e" in window)).toBe(false);
      // Nothing a page script can call makes a screen fail.
      await page.evaluate(() => {
        window.obdE2eFail?.({ kind: "render", screen: "connection", message: "forced" });
      });
      await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();
      await expect(page.getByText("could not be shown")).toHaveCount(0);
    } finally {
      await server.close();
    }
  });
});
