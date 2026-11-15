/**
 * Decides whether a release has to be tagged for the version in `package.json`. The release
 * workflow pipes the repository's existing tag names to this script on standard input and appends
 * its output to `GITHUB_OUTPUT`, so a push that does not change the version tags nothing.
 */
import { readFileSync } from "node:fs";

/** A semantic version, with an optional pre-release suffix and no build metadata. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What the release workflow needs to know about the current version. */
export interface ReleaseDecision {
  readonly version: string;
  /** The tag the release is published under: the version with a leading `v`. */
  readonly tag: string;
  /** True when `tag` is absent from the tags given, so a release has to be created. */
  readonly needed: boolean;
}

/**
 * Reads the `version` field of a `package.json` text.
 *
 * @param packageJson The text of the file.
 * @returns The version, checked to be a semantic version.
 * @throws When the text is not a JSON object with a semantic-version `version` string.
 */
export function readVersion(packageJson: string): string {
  const parsed: unknown = JSON.parse(packageJson);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json has no version field");
  }
  const { version } = parsed;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`package.json version is not a semantic version: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Decides whether `version` still needs a release.
 *
 * @param version A semantic version, without a leading `v`.
 * @param tags The names of every existing tag in the repository.
 * @returns The tag for the version and whether it is missing from `tags`.
 */
export function releaseDecision(version: string, tags: readonly string[]): ReleaseDecision {
  const tag = `v${version}`;
  return { version, tag, needed: !tags.includes(tag) };
}

/** Formats a decision as the `key=value` lines GitHub Actions reads from `GITHUB_OUTPUT`. */
export function formatOutput(decision: ReleaseDecision): string {
  return `version=${decision.version}\ntag=${decision.tag}\nneeded=${String(decision.needed)}\n`;
}

if (import.meta.main) {
  const tags = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const version = readVersion(readFileSync("package.json", "utf8"));
  process.stdout.write(formatOutput(releaseDecision(version, tags)));
}
