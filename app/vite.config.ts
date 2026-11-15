import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { readReleasedVersion, versionDefine } from "./app-version.ts";
import { basePathFrom } from "./base-path.ts";

/** Theme colours of the manifest: the icon's navy, and the light theme's background. */
const THEME_COLOUR = "#0b3d5c";
const BACKGROUND_COLOUR = "#f5f7f9";

/** Where the build is served from: `/` for local use, `/<repository>/` on a GitHub Pages project site. */
const BASE_PATH = basePathFrom(process.env);

/** The commit the build was made from, shown in a problem report; `unknown` when the sources are not a git checkout. */
function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: {
    ...versionDefine(readReleasedVersion()),
    "import.meta.env.VITE_OBD_BUILD": JSON.stringify(buildCommit()),
  },
  plugins: [
    vanillaExtractPlugin(),
    react(),
    VitePWA({
      // The page asks before replacing a running copy, so a scan is never interrupted by an update.
      registerType: "prompt",
      pwaAssets: { config: true },
      manifest: {
        name: "obd-read",
        short_name: "obd-read",
        description: "Read cars through ELM327-style adapters, offline.",
        lang: "en-GB",
        display: "standalone",
        orientation: "any",
        id: BASE_PATH,
        start_url: BASE_PATH,
        scope: BASE_PATH,
        theme_color: THEME_COLOUR,
        background_color: BACKGROUND_COLOUR,
      },
      workbox: {
        // The whole shell, the bundled profiles and the generated icons are precached. The web
        // app manifest is not globbed here: the plugin adds it, and listing it twice with two
        // revisions makes Workbox's install fail, leaving nothing cached.
        // The database worker is a .js chunk and its SQLite engine a .wasm asset: both are part of
        // the shell, so the stored data opens offline from the first reload.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,json,wasm}"],
        // sqlite-wasm's Worker1 and OPFS async proxy scripts are emitted because the library
        // mentions them, but the app uses neither: the sahpool VFS runs inside database.worker.
        globIgnores: ["**/sqlite3-worker1-*.js", "**/sqlite3-opfs-async-proxy-*.js"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // The database and service workers are ES module workers: sqlite-wasm resolves its WebAssembly file with
  // import.meta.url, which the default IIFE worker format cannot express.
  worker: { format: "es" },
  // Absolute, so a deep link below the base still resolves its assets; the service worker's scope follows it.
  base: BASE_PATH,
  build: {
    target: "es2023",
    // The whole bundle is precached for offline use, so one chunk is the cheaper shape here.
    chunkSizeWarningLimit: 1200,
  },
});
