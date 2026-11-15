import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads the `version` of the repository's root `package.json`, the single source of the version
 * the app shows. The build and the tests inject it as the `__APP_VERSION__` constant.
 *
 * @returns The version string, for example `0.1.0`.
 * @throws When the file has no string `version`.
 */
export function readRootVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed;
    if (typeof version === "string" && version !== "") return version;
  }
  throw new Error("The root package.json has no version.");
}

/**
 * The `define` entry that injects a version as the `__APP_VERSION__` constant.
 *
 * @param version The version to inject.
 * @returns A Vite `define` record whose value is the JSON-quoted version.
 */
export function versionDefine(version: string): Record<string, string> {
  return { __APP_VERSION__: JSON.stringify(version) };
}
