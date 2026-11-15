/** The version of this program, read from the package's own `package.json`. */

import { readFileSync } from "node:fs";

/**
 * The `version` of the package this module ships in: `package.json` sits two directories up, from `src/node/` and from `dist/node/` alike.
 *
 * @throws Error when the file has no string `version`.
 */
export function toolVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed;
    if (typeof version === "string" && version !== "") return version;
  }
  throw new Error("package.json has no version");
}
