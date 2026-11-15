/**
 * Validation of a vehicle profile beyond what loading needs, without connecting to anything.
 *
 * This module is platform-free: it takes parsed profile JSON (or its text). Finding a profile by name or path is the caller's job.
 */

import {
  canBusSchema,
  klineBusSchema,
  parseJson,
  profileFileSchema,
  ProfileError,
  STATUSES,
  unitSchema,
  validateProfile,
  valueSchema,
  type ProfileFile,
} from "./profile.js";
import { pythonRepr } from "./format.js";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_CAN_ID = { 11: 0x7ff, 29: 0x1fffffff } as const;
const MAX_KLINE_ADDRESS = 0xff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: string): boolean {
  return STATUSES.some((status) => status === value);
}

function unknownKeys(table: unknown, allowed: readonly string[], label: string): string[] {
  if (!isRecord(table)) return [];
  return Object.keys(table)
    .filter((key) => !allowed.includes(key))
    .sort()
    .map((key) => `${label}: unknown key ${key}`);
}

/** Keys the schema does not define, at every level of the raw file, from the schema's own shapes so the two cannot drift. `raw` is the data `file` was validated from. */
function unrecognisedKeys(raw: unknown, file: ProfileFile): string[] {
  const problems = unknownKeys(raw, Object.keys(profileFileSchema.shape), "profile");
  if (!isRecord(raw)) return problems;
  const busShape = "kline" in file.bus ? klineBusSchema.shape : canBusSchema.shape;
  problems.push(...unknownKeys(raw.bus, Object.keys(busShape), "[bus]"));
  problems.push(
    ...unknownKeys(
      raw.diagnostics,
      Object.keys(profileFileSchema.shape.diagnostics.shape),
      "[diagnostics]",
    ),
  );
  const rawUnits = raw.units;
  if (!isRecord(rawUnits)) return problems;
  for (const [name, unit] of Object.entries(rawUnits)) {
    problems.push(...unknownKeys(unit, Object.keys(unitSchema.shape), `[units.${name}]`));
    const values = isRecord(unit) ? unit.values : undefined;
    if (!isRecord(values)) continue;
    for (const [valueName, value] of Object.entries(values)) {
      problems.push(
        ...unknownKeys(
          value,
          Object.keys(valueSchema.shape),
          `[units.${name}.values.${valueName}]`,
        ),
      );
    }
  }
  return problems;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

/**
 * Lists everything wrong with a profile's parsed JSON; an empty list means it is sound.
 *
 * Covers what loading rejects (each reported with where it is, prefixed by `where`), and also unknown keys (a misspelt optional-looking key is otherwise silently ignored), a status other than confirmed or unconfirmed, a name that is not lower-case words joined by hyphens, blank descriptions and sources, identifiers wider than the bus allows (a CAN identifier for its width, a K-line address for one byte), a CAN unit whose request and response identifiers are the same, and any identifier shared by two units, which makes a reply impossible to attribute. For named values: unknown keys, a status other than confirmed or unconfirmed, a blank source and a zero scale.
 */
export function checkProfile(data: unknown, where: string): string[] {
  const validated = validateProfile(data, where);
  if (validated.file === undefined) return validated.problems;
  const profile = validated.file;
  const problems = unrecognisedKeys(data, profile);

  if (!isStatus(profile.status)) {
    problems.push(`status must be confirmed or unconfirmed, got ${pythonRepr(profile.status)}`);
  }
  if (!NAME.test(profile.name)) {
    problems.push(`name ${pythonRepr(profile.name)} must be lower-case words joined by hyphens`);
  }
  if (profile.description.trim() === "") problems.push("description is blank");

  for (const [unitName, unit] of Object.entries(profile.units)) {
    for (const [valueName, value] of Object.entries(unit.values ?? {})) {
      const label = `[units.${unitName}.values.${valueName}]`;
      if (!isStatus(value.status))
        problems.push(`${label}: status must be confirmed or unconfirmed`);
      if (value.source.trim() === "")
        problems.push(`${label}: source is blank, so the identifier cannot be traced`);
      if (value.scale === 0) problems.push(`${label}: scale is zero, so every reading is the bias`);
    }
  }

  const can = "id_bits" in profile.bus ? profile.bus.id_bits : undefined;
  const limit = can === undefined ? MAX_KLINE_ADDRESS : MAX_CAN_ID[can];
  const width = can === undefined ? "one-byte K-line addresses" : `${String(can)}-bit identifiers`;
  const requests = new Map<number, string>();
  const responses = new Map<number, string>();
  for (const [unitName, unit] of Object.entries(profile.units)) {
    const label = `[units.${unitName}]`;
    if (unit.description.trim() === "") problems.push(`${label}: description is blank`);
    if (unit.source.trim() === "")
      problems.push(`${label}: source is blank, so the address cannot be traced`);
    for (const [kind, value] of [
      ["request", unit.request],
      ["response", unit.response],
    ] as const) {
      if (value < 0 || value > limit)
        problems.push(`${label}: ${kind} ${hex(value)} does not fit ${width}`);
    }
    if (can !== undefined && unit.request === unit.response) {
      problems.push(`${label}: request and response are both ${hex(unit.request)}`);
    }
    for (const [kind, value, seen] of [
      ["request", unit.request, requests],
      ["response", unit.response, responses],
    ] as const) {
      const other = seen.get(value);
      if (other === undefined) seen.set(value, unitName);
      else problems.push(`${label}: ${kind} ${hex(value)} is also used by ${other}`);
    }
  }
  return problems;
}

/**
 * Checks a profile's JSON text. Text that is not JSON is one problem.
 */
export function checkProfileText(text: string, where: string): string[] {
  let data: unknown;
  try {
    data = parseJson(text, where);
  } catch (error) {
    if (error instanceof ProfileError) return [...error.problems];
    throw error;
  }
  return checkProfile(data, where);
}

/**
 * The report lines for one checked profile: `<where>: ok`, or `<where>: N problem(s)` followed by each problem indented by two spaces.
 *
 * The caller exits with status 1 when any profile it checked had a problem or could not be found.
 */
export function profileCheckReport(where: string, problems: readonly string[]): string[] {
  if (problems.length === 0) return [`${where}: ok`];
  return [
    `${where}: ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}`,
    ...problems.map((p) => `  ${p}`),
  ];
}
