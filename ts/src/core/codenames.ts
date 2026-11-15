/**
 * Names for fault codes: the open generic list, per-profile tables and imported name files.
 *
 * Three sources, each reported with where its text came from:
 *
 * - the generic OBD-II code titles bundled in `src/data/obdex-generic.json`, for codes in the SAE form such as P0420;
 * - a `codes` table in a profile (unit, then hexadecimal code), each entry carrying its own `source`;
 * - a names file written by `obd-read import-names` from a definition file the user supplied.
 *
 * Nothing here invents text: a code with no entry is reported as having none. This module is platform-free: it takes parsed JSON and never reads a file.
 */

import { z } from "zod";
import { pythonRepr } from "./format.js";

/** Where the generic code titles came from. */
export const GENERIC_SOURCE = "OBDex generic code list, CC0 (https://github.com/foerbsnavi/OBDex)";

/** The `kind` field of a names file. */
export const NAMES_FILE_KIND = "names";

const SAE_CODE = /^[PBCU][0-3][0-9A-F]{3}$/;
const HEX_CODE = /^[0-9A-Fa-f]{1,6}$/;

/** A code table or names file is malformed. */
export class CodeNameError extends Error {
  override name = "CodeNameError";
}

/** A code's text and where it came from. */
export interface Described {
  readonly text: string;
  readonly source: string;
}

/** Code texts by normalised code. */
export type CodeTable = ReadonlyMap<string, Described>;

/**
 * The key a code is stored under: SAE codes upper-cased, hexadecimal codes as at least four digits.
 *
 * Throws {@link CodeNameError} when the code is neither form.
 */
export function normaliseCode(code: string): string {
  const candidate = code.trim();
  if (SAE_CODE.test(candidate.toUpperCase())) return candidate.toUpperCase();
  if (HEX_CODE.test(candidate)) {
    return parseInt(candidate, 16).toString(16).toUpperCase().padStart(4, "0");
  }
  throw new CodeNameError(
    `${pythonRepr(code)} is neither an SAE code such as P0420 nor hexadecimal bytes`,
  );
}

const genericTitlesSchema = z.object({ titles: z.record(z.string(), z.string()) });

/**
 * The generic code titles keyed by SAE code, from the parsed bundled data file (`{ titles: { P0420: "..." } }`).
 *
 * Throws {@link CodeNameError} when the data has another shape.
 */
export function parseGenericTitles(data: unknown): ReadonlyMap<string, string> {
  const parsed = genericTitlesSchema.safeParse(data);
  if (!parsed.success)
    throw new CodeNameError("the generic code titles are not { titles: { code: text } }");
  return new Map(Object.entries(parsed.data.titles));
}

const missingOr = (expected: string) => (issue: z.core.$ZodRawIssue) =>
  issue.input === undefined ? "missing" : `must be ${expected}`;

/**
 * The shape of a profile's `codes` table: unit name, then code, then text and a non-empty source.
 *
 * Whether each unit exists and each code normalises is checked by {@link parseProfileCodes}.
 */
export const profileCodesSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({
      text: z.string({ error: missingOr("text") }),
      source: z.string({ error: missingOr("text") }).min(1, { error: "must not be empty" }),
    }),
  ),
);

/** A profile's `codes` table as parsed from its JSON. */
export type ProfileCodes = z.output<typeof profileCodesSchema>;

/**
 * What is wrong with a profile's `codes` table beyond its shape: a unit the profile does not define, a code that is neither an SAE code nor hexadecimal, or two codes that normalise to one key.
 *
 * Each problem is `[unit, code, message]`, with `code` undefined when the whole unit table is at fault.
 */
export function codeTableProblems(
  codes: ProfileCodes,
  unitNames: ReadonlySet<string>,
): [unit: string, code: string | undefined, message: string][] {
  const problems: [string, string | undefined, string][] = [];
  for (const [unit, entries] of Object.entries(codes)) {
    if (!unitNames.has(unit)) {
      problems.push([unit, undefined, "names a unit the profile does not define"]);
      continue;
    }
    const seen = new Set<string>();
    for (const code of Object.keys(entries)) {
      let key: string;
      try {
        key = normaliseCode(code);
      } catch (error) {
        if (error instanceof CodeNameError) {
          problems.push([unit, code, error.message]);
          continue;
        }
        throw error;
      }
      if (seen.has(key)) problems.push([unit, code, `duplicates another entry for ${key}`]);
      seen.add(key);
    }
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The per-unit code tables of a profile, keyed by unit then normalised code.
 *
 * `profile` is the parsed profile JSON and `where` names its source in error messages. Every entry needs `text` and a non-empty `source`, and the unit must be one the profile defines. Throws {@link CodeNameError} otherwise. A profile with no `codes` table gives an empty result.
 */
export function parseProfileCodes(profile: unknown, where: string): ReadonlyMap<string, CodeTable> {
  if (!isRecord(profile)) throw new CodeNameError(`${where}: a profile must be an object`);
  const tables = profile.codes ?? {};
  const units = profile.units ?? {};
  if (!isRecord(tables) || !isRecord(units)) {
    throw new CodeNameError(`${where}: codes and units must be tables`);
  }
  const parsed = profileCodesSchema.safeParse(tables);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const [unit, code] = issue?.path ?? [];
    const section = `${where} [codes.${String(unit)}${code === undefined ? "" : `.${String(code)}`}]`;
    throw new CodeNameError(`${section}: needs text and a non-empty source, both strings`);
  }
  const problems = codeTableProblems(parsed.data, new Set(Object.keys(units)));
  const first = problems[0];
  if (first !== undefined) {
    const [unit, code, message] = first;
    throw new CodeNameError(
      `${where} [codes.${unit}${code === undefined ? "" : `.${code}`}]: ${message}`,
    );
  }
  const result = new Map<string, CodeTable>();
  for (const [unit, entries] of Object.entries(parsed.data)) {
    const named = new Map<string, Described>();
    for (const [code, entry] of Object.entries(entries)) {
      named.set(normaliseCode(code), { text: entry.text, source: entry.source });
    }
    result.set(unit, named);
  }
  return result;
}

/** Names imported from a definition file: fault-code texts and data-value names per unit. */
export interface NamesFile {
  readonly source: string;
  readonly codes: ReadonlyMap<string, CodeTable>;
  readonly values: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** The saved form of a names file. */
export interface NamesDocument {
  readonly tool: "obd-read";
  readonly kind: typeof NAMES_FILE_KIND;
  readonly source: string;
  readonly units: Readonly<
    Record<
      string,
      {
        readonly codes: Readonly<Record<string, string>>;
        readonly values: Readonly<Record<string, string>>;
      }
    >
  >;
}

function sortedRecord(entries: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The saved form of an import for one unit, as written by `obd-read import-names`, with codes and values in key order. */
export function namesDocument(
  source: string,
  unit: string,
  codes: ReadonlyMap<string, string>,
  values: ReadonlyMap<string, string>,
): NamesDocument {
  return {
    tool: "obd-read",
    kind: NAMES_FILE_KIND,
    source,
    units: { [unit]: { codes: sortedRecord(codes), values: sortedRecord(values) } },
  };
}

/**
 * Reads a names file from its parsed JSON; `where` names its source in error messages.
 *
 * Throws {@link CodeNameError} when it is not a names file or a unit's codes are not text. A value whose label is not text is dropped.
 */
export function parseNamesFile(data: unknown, where: string): NamesFile {
  if (!isRecord(data) || data.kind !== NAMES_FILE_KIND) {
    throw new CodeNameError(`${where}: not a names file written by obd-read import-names`);
  }
  const source = data.source;
  const units = data.units;
  if (typeof source !== "string" || !isRecord(units)) {
    throw new CodeNameError(`${where}: needs a source and a units object`);
  }
  const codes = new Map<string, CodeTable>();
  const values = new Map<string, ReadonlyMap<string, string>>();
  for (const [unit, body] of Object.entries(units)) {
    if (!isRecord(body)) throw new CodeNameError(`${where}: unit ${unit} must be an object`);
    const rawCodes = body.codes ?? {};
    const rawValues = body.values ?? {};
    if (!isRecord(rawCodes) || !isRecord(rawValues)) {
      throw new CodeNameError(`${where}: unit ${unit} codes and values must be objects`);
    }
    const unitCodes = new Map<string, Described>();
    for (const [code, text] of Object.entries(rawCodes)) {
      if (typeof text !== "string")
        throw new CodeNameError(`${where}: unit ${unit} code ${code} must have text`);
      unitCodes.set(normaliseCode(code), { text, source: `imported from ${source}` });
    }
    codes.set(unit, unitCodes);
    const unitValues = new Map<string, string>();
    for (const [name, label] of Object.entries(rawValues)) {
      if (typeof label === "string") unitValues.set(name, label);
    }
    values.set(unit, unitValues);
  }
  return { source, codes, values };
}

/**
 * Reads a names file from its JSON text; `where` names its source in error messages.
 *
 * Throws {@link CodeNameError} when the text is not JSON or not a names file.
 */
export function parseNamesFileText(text: string, where: string): NamesFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodeNameError(`${where}: ${error.message}`);
    throw error;
  }
  return parseNamesFile(data, where);
}

/** Looks a code up in the sources that apply, most specific first. */
export class CodeNames {
  constructor(
    private readonly generic: ReadonlyMap<string, string>,
    private readonly profileCodes: ReadonlyMap<string, CodeTable>,
    private readonly imported: readonly NamesFile[],
  ) {}

  /** The text for a code a unit reported: the profile's table first, then imported names in order. Throws {@link CodeNameError} when `code` is not a valid code. */
  unitCode(unit: string, code: string): Described | undefined {
    const key = normaliseCode(code);
    const fromProfile = this.profileCodes.get(unit)?.get(key);
    if (fromProfile !== undefined) return fromProfile;
    for (const names of this.imported) {
      const found = names.codes.get(unit)?.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The generic OBD-II title for an SAE code such as P0420. Throws {@link CodeNameError} when `code` is not a valid code. */
  genericCode(code: string): Described | undefined {
    const title = this.generic.get(normaliseCode(code));
    return title === undefined ? undefined : { text: title, source: GENERIC_SOURCE };
  }
}
