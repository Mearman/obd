/** Synthetic profiles and helpers shared by the profile, check and names tests. They hold no maker data. */

/** A profile document as parsed JSON. */
export type Json = Record<string, unknown>;

/**
 * A copy of `base` with the value at `path` replaced, or removed when `value` is undefined.
 *
 * Throws when a step of the path is not an object, so a test cannot silently edit nothing.
 */
export function edit(base: Json, path: readonly string[], value: unknown): Json {
  const copy = structuredClone(base);
  let node: unknown = copy;
  for (const key of path.slice(0, -1)) {
    node = typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;
  }
  const last = path.at(-1);
  if (typeof node !== "object" || node === null || last === undefined) {
    throw new Error(`no object at ${path.join(".")}`);
  }
  if (value === undefined) Reflect.deleteProperty(node, last);
  else Reflect.set(node, last, value);
  return copy;
}

/** The smallest sound UDS profile. */
export const MINIMAL: Json = {
  name: "test-car",
  description: "A car for tests",
  status: "confirmed",
  bus: { id_bits: 11, bitrate: 500000 },
  diagnostics: { protocol: "uds", session: 0x03 },
  units: {
    engine: {
      description: "Engine",
      request: 0x7e0,
      response: 0x7e8,
      source: "made up for the test",
    },
  },
};

/** A KWP2000 profile with named values of every default and flag. */
export const KWP_PROFILE: Json = {
  name: "test-kwp",
  description: "A car for tests",
  status: "confirmed",
  bus: { id_bits: 11, bitrate: 500000 },
  diagnostics: { protocol: "kwp2000", session: 0x92 },
  units: {
    engine: {
      description: "Engine",
      request: 0x7e0,
      response: 0x7e8,
      source: "made up for the test",
      values: {
        boost: {
          label: "boost pressure",
          unit: "kPa",
          identifier: 0x10,
          offset: 1,
          size: 2,
          scale: 0.1,
          source: "made up for the test",
          status: "confirmed",
        },
        "rail-temperature": {
          label: "rail temperature",
          unit: "°C",
          identifier: 0x11,
          signed: true,
          bias: -40,
          source: "made up for the test",
        },
        refused: { label: "refused value", identifier: 0x7f, source: "made up for the test" },
      },
    },
  },
};

/** A K-line profile. */
export const KLINE_PROFILE: Json = {
  name: "test-kline",
  description: "A K-line car for tests",
  status: "confirmed",
  bus: { kline: "kwp2000-fast" },
  diagnostics: { protocol: "kwp2000", session: 0x81 },
  units: {
    engine: {
      description: "Engine",
      request: 0x10,
      response: 0x10,
      source: "made up for the test",
    },
    abs: { description: "ABS", request: 0x28, response: 0x28, source: "made up for the test" },
  },
};

/** A KWP2000 profile with a code table for the ESP unit. */
export const CODES_PROFILE: Json = {
  name: "test-car",
  description: "A car for tests",
  status: "confirmed",
  bus: { id_bits: 11, bitrate: 500000 },
  diagnostics: { protocol: "kwp2000", session: 0x92 },
  units: {
    esp: { description: "ESP", request: 0x784, response: 0x785, source: "made up for the test" },
  },
  codes: {
    esp: { "5123": { text: "Wheel speed sensor, front left", source: "invented for the test" } },
  },
};
