import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

/** Every icon of the manifest, the favicon and the Apple touch icon come from this one SVG. */
export default defineConfig({
  preset: minimal2023Preset,
  images: ["public/icon.svg"],
});
