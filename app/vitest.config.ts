import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { versionDefine } from "./app-version.ts";

/** A version no release uses, so a test that finds it on the page knows it was injected. */
const TEST_VERSION = "9.8.7-test";

export default defineConfig({
  define: versionDefine(TEST_VERSION),
  plugins: [vanillaExtractPlugin(), react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    css: false,
    // Each worker is a process of its own, so the processor time the work budget in test/setup.ts reads is one test's.
    pool: "forks",
    // Elapsed-time limits fail correct tests on a busy machine; the work budget in test/setup.ts limits each test and its hooks instead.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
