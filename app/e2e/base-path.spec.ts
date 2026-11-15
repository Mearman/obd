import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { serveUnderPrefix, type StaticServer } from "./static-server";

/** Every public path the build must work under: local use, and a GitHub Pages project site. */
const BASE_PATHS = ["/", "/obd/"] as const;

const BUILDS = resolve(import.meta.dirname, "..", "test-results", "base-path-builds");

/** The `src` of every icon a parsed web app manifest lists; empty when it lists none. */
function iconSources(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null || !("icons" in manifest)) return [];
  const { icons } = manifest;
  if (!Array.isArray(icons)) return [];
  return icons.flatMap((icon: unknown) =>
    typeof icon === "object" && icon !== null && "src" in icon && typeof icon.src === "string"
      ? [icon.src]
      : [],
  );
}

for (const basePath of BASE_PATHS) {
  test.describe(`served under ${basePath}`, () => {
    // One build and one server per base path, shared by the tests below.
    test.describe.configure({ mode: "serial" });

    let server: StaticServer;
    let root: string;

    test.beforeAll(async () => {
      const outDir = join(BUILDS, basePath === "/" ? "root" : basePath.replaceAll("/", ""));
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      execFileSync("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, BASE_PATH: basePath },
        stdio: "pipe",
      });
      server = await serveUnderPrefix(outDir, basePath);
      root = `${server.origin}${basePath}`;
    });

    test.afterAll(async () => {
      await server.close();
    });

    test("serves nothing outside the base path", async ({ request }) => {
      if (basePath === "/") return;
      expect((await request.get(`${server.origin}/`)).status()).toBe(404);
      expect((await request.get(`${server.origin}/index.html`)).status()).toBe(404);
      expect((await request.get(root)).status()).toBe(200);
    });

    test("the manifest scope, start URL and id resolve under the base path", async ({
      page,
      request,
    }) => {
      await page.goto(root);
      const href = await page.locator('link[rel="manifest"]').getAttribute("href");
      expect(href).not.toBeNull();
      const manifestUrl = new URL(href ?? "", page.url());
      expect(manifestUrl.pathname.startsWith(basePath)).toBe(true);
      const manifest: unknown = await (await request.get(manifestUrl.toString())).json();
      expect(manifest).toMatchObject({ id: basePath, scope: basePath, start_url: basePath });

      const sources = iconSources(manifest);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        const url = new URL(source, manifestUrl);
        expect(url.pathname.startsWith(basePath), url.pathname).toBe(true);
        expect((await request.get(url.toString())).status(), url.pathname).toBe(200);
      }
    });

    test("the service worker registers with the base path as its scope", async ({ page }) => {
      await page.goto(root);
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      expect(scope).toBe(root);
    });

    test("a deep link loads the shell, and the shell reloads offline", async ({
      page,
      context,
    }) => {
      await page.goto(root);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      await expect
        .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
        .toBe(true);

      // The static server has no fallback, so only the service worker can answer this.
      await page.goto(`${root}some/deep/link`);
      await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();

      await context.setOffline(true);
      await page.goto(root);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();
      await page.getByRole("button", { name: /connect with the simulator/i }).click();
      await expect(page.getByText("Connected to Simulator")).toBeVisible();
      await context.setOffline(false);
    });
  });
}
