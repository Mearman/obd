import { defineConfig } from "@playwright/test";

const PORT = 4173;

/**
 * Optional path to a Chromium or headless-shell binary, for a machine whose cached Playwright
 * browser revision differs from the one this Playwright version installs. Unset, Playwright uses
 * the browser `playwright install chromium` fetched.
 */
const executablePath = process.env.OBD_READ_CHROMIUM;

/**
 * Builds the app (with the `window.obdE2e` database hook, which the shipped build lacks), serves the production build with `vite preview` on localhost (a secure context,
 * which service workers need) and runs the checks in `e2e/`. No hardware and no outside network.
 */
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  webServer: {
    command: "VITE_OBD_E2E=1 pnpm exec vite build && pnpm preview",
    url: `http://127.0.0.1:${String(PORT)}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
