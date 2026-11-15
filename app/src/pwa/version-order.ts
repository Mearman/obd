/** The parts of a semantic version that decide its order: the numeric core and the pre-release identifiers. */
interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version: string): ParsedVersion | undefined {
  const match = VERSION.exec(version);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

const NUMERIC = /^\d+$/;

/** Orders two pre-release identifiers as semantic versioning does: numbers numerically and below any text, text by ASCII. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two versions by semantic versioning precedence (https://semver.org/#spec-item-11): the core numbers first, then a version with a pre-release below the same version without one, then the pre-release identifiers in turn. Build metadata is ignored.
 *
 * @returns A negative number when `a` is older, positive when newer, zero when they rank the same, and undefined when either is not a semantic version, so a malformed version from another tab is never taken as newer.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return undefined;
  const [lMajor, lMinor, lPatch] = left.core;
  const [rMajor, rMinor, rPatch] = right.core;
  const core =
    Math.sign(lMajor - rMajor) || Math.sign(lMinor - rMinor) || Math.sign(lPatch - rPatch);
  if (core !== 0) return core;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const difference = compareIdentifier(l, r);
    if (difference !== 0) return difference;
  }
  return 0;
}
