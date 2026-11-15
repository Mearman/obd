/**
 * Canonical JSON: the same value always written as the same bytes, so it can be compared, hashed and compressed reproducibly. This module is platform-free and imports nothing, so any module may use it.
 */

import type { Json } from "./storage.js";

function sorted(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      // A key whose value is undefined is left out, as JSON.stringify leaves it out.
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  throw new TypeError("canonical JSON holds only JSON values");
}

/** JSON with every object's keys sorted and every character outside printable ASCII written as `\uXXXX`, so the same value is always the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
