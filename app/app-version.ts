import { execFileSync } from "node:child_process";

/**
 * The version of the latest release, read from the repository's git tags (`v<version>`). Releases
 * are made from the commit messages and leave no commit behind, so the tag is the only record of the
 * version, and the build and the tests inject what it names as the `__APP_VERSION__` constant.
 *
 * @returns The version string, for example `0.1.0`.
 * @throws When the repository has no `v<version>` tag, as in a shallow clone without tags.
 */
export function readReleasedVersion(): string {
  const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
  return tag.slice(1);
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
