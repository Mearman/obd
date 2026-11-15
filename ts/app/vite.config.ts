import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Theme colours of the manifest: the icon's navy, and the light theme's background. */
const THEME_COLOUR = "#0b3d5c";
const BACKGROUND_COLOUR = "#f5f7f9";

export default defineConfig({
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
        start_url: ".",
        scope: ".",
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
  // The database worker is an ES module worker: sqlite-wasm resolves its WebAssembly file with
  // import.meta.url, which the default IIFE worker format cannot express.
  worker: { format: "es" },
  // Relative URLs let the static build be served from any path.
  base: "./",
  build: {
    target: "es2023",
    // The whole bundle is precached for offline use, so one chunk is the cheaper shape here.
    chunkSizeWarningLimit: 1200,
  },
});
