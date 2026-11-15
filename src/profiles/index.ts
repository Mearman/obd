/**
 * The vehicle profiles shipped with the package, as a registry that works in Node and in the browser.
 *
 * The JSON files are imported rather than read, so a bundler includes them and no file access is needed. A profile from anywhere else (a file the user picks, a document in storage) goes through `parseProfile` in core.
 */

import { pythonRepr } from "../core/format.js";
import { ProfileError, parseProfile, type Profile } from "../core/profile.js";
import bmwFFem from "./bmw-f-fem.json" with { type: "json" };
import bmwG29 from "./bmw-g29.json" with { type: "json" };
import bmwI3 from "./bmw-i3.json" with { type: "json" };
import mercedesW211 from "./mercedes-w211.json" with { type: "json" };
import vagMqb from "./vag-mqb.json" with { type: "json" };

const SHIPPED: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["bmw-f-fem", bmwFFem],
  ["bmw-g29", bmwG29],
  ["bmw-i3", bmwI3],
  ["mercedes-w211", mercedesW211],
  ["vag-mqb", vagMqb],
]);

/** Names of the profiles shipped with the package, sorted. */
export function builtinProfiles(): string[] {
  return [...SHIPPED.keys()].sort();
}

/**
 * The parsed JSON of a shipped profile, unvalidated, as `checkProfile` and `parseProfile` take it.
 *
 * Throws {@link ProfileError} listing the shipped names when there is no such profile.
 */
export function builtinProfileData(name: string): unknown {
  if (!SHIPPED.has(name)) {
    throw new ProfileError([
      `no profile named ${pythonRepr(name)}; shipped profiles: ${builtinProfiles().join(", ")}`,
    ]);
  }
  return SHIPPED.get(name);
}

/** Loads a shipped profile by name. Throws {@link ProfileError} when there is no such profile or it is invalid. */
export function loadBuiltinProfile(name: string): Profile {
  return parseProfile(builtinProfileData(name), name);
}
