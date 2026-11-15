/**
 * Vehicle profiles: the bus settings and control-unit addresses for one chassis.
 *
 * A profile is a JSON document described by {@link profileFileSchema}; the TypeScript types are derived from that schema. This module is platform-free: it takes parsed JSON (or its text) and never reads a file. The profiles shipped with the package are exposed by the registry in `src/profiles/`.
 */

import { z } from "zod";
import { DiagProtocol, READ_ONLY } from "./guard.js";
import { pythonRepr } from "./format.js";
import { codeTableProblems, profileCodesSchema } from "./codenames.js";

/** A profile file is malformed or asks for something this tool will not send. */
export class ProfileError extends Error {
  override name = "ProfileError";

  /** Every problem found, each prefixed with where it is; the message joins them. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("; "));
    this.problems = problems;
  }
}

/** The diagnostic protocols a profile may name. */
export const PROFILE_PROTOCOLS = [DiagProtocol.KWP2000, DiagProtocol.UDS] as const;

/** A diagnostic protocol a profile may name. */
export type ProfileProtocol = (typeof PROFILE_PROTOCOLS)[number];

/**
 * Whether the guard's read-only allowlist permits opening `session` with service 0x10 under `protocol`. A profile may only name such a session.
 */
export function isReadOnlySession(protocol: ProfileProtocol, session: number): boolean {
  const allowed = READ_ONLY[protocol].get(0x10);
  return allowed === null || allowed === undefined ? allowed === null : allowed.has(session);
}

/**
 * The widest identifier each protocol's read-by-identifier service takes: KWP2000 service 21 reads a one-byte local identifier, UDS service 22 a two-byte data identifier.
 */
export const MAX_IDENTIFIER: Readonly<Record<ProfileProtocol, number>> = {
  [DiagProtocol.KWP2000]: 0xff,
  [DiagProtocol.UDS]: 0xffff,
};

/** The most bytes a named value may span. */
export const MAX_VALUE_BYTES = 4;

/** The ELM327 protocol number for each K-line initialisation scheme, with the header format byte used unless the profile gives one. */
export const KLINE_SCHEMES = {
  iso9141: { protocol: "3", headerFormat: 0x68 },
  "kwp2000-slow": { protocol: "4", headerFormat: 0xc0 },
  "kwp2000-fast": { protocol: "5", headerFormat: 0xc0 },
} as const;

/** Every K-line initialisation scheme a profile may name. */
export const KLINE_SCHEME_NAMES = [
  "iso9141",
  "kwp2000-slow",
  "kwp2000-fast",
] as const satisfies readonly (keyof typeof KLINE_SCHEMES)[];

/** A K-line initialisation scheme. */
export type KLineScheme = (typeof KLINE_SCHEME_NAMES)[number];

/**
 * The address a tester uses on a K-line unit unless the profile gives one. It is also the ELM327's default tester address (`AT TA`), which this tool never changes, so under CAN extended addressing it is the byte every reply must start with: the datasheet says `AT CEA` passes only received messages "that have the Tester Address in the first byte position" (ELM327 datasheet, "CEA hh").
 */
export const DEFAULT_TESTER = 0xf1;

/** A status a profile, unit value or sourced fact may carry. */
export const STATUSES = ["confirmed", "unconfirmed"] as const;

const MISSING = "missing";

/**
 * The text of an issue about a field: {@link MISSING} when the field is absent, otherwise what it must be and what it was. The formatter turns it into "missing <key>" or "<key> <text>".
 */
const wrong =
  (expected: string) =>
  (issue: z.core.$ZodRawIssue): string =>
    issue.input === undefined ? MISSING : `must be ${expected}, got ${JSON.stringify(issue.input)}`;

const object = <Shape extends z.core.$ZodShape>(shape: Shape): z.ZodObject<Shape> =>
  z.object(shape, { error: wrong("an object") });
const text = (): z.ZodString => z.string({ error: wrong("text") });
const whole = (): z.ZodNumber => z.int({ error: wrong("a whole number") });
const byte = (): z.ZodNumber =>
  whole().min(0, { error: "must fit in one byte" }).max(0xff, { error: "must fit in one byte" });

export const valueSchema = object({
  label: text(),
  unit: text().default(""),
  identifier: whole(),
  offset: whole().min(0, { error: "must be a whole number of bytes, at least 0" }).default(0),
  size: whole()
    .min(1, { error: `must be 1 to ${String(MAX_VALUE_BYTES)} bytes` })
    .max(MAX_VALUE_BYTES, { error: `must be 1 to ${String(MAX_VALUE_BYTES)} bytes` })
    .default(1),
  signed: z.boolean({ error: wrong("true or false") }).default(false),
  scale: z.number({ error: wrong("a number") }).default(1),
  bias: z.number({ error: wrong("a number") }).default(0),
  source: text(),
  status: text().default("unconfirmed"),
});

export const unitSchema = object({
  description: text(),
  request: whole(),
  response: whole(),
  extended_address: byte().optional(),
  id_bits: z.literal([11, 29], { error: wrong("11 or 29") }).optional(),
  source: text(),
  values: z.record(z.string(), valueSchema).optional(),
});

export const canBusSchema = object({
  id_bits: z.literal([11, 29], { error: wrong("11 or 29") }),
  bitrate: whole().positive({ error: "must be positive" }),
});

export const klineBusSchema = object({
  kline: z.literal(KLINE_SCHEME_NAMES, { error: wrong(`one of ${KLINE_SCHEME_NAMES.join(", ")}`) }),
  tester: byte().optional(),
  header_format: byte().optional(),
});

/**
 * The schema of a profile file. The types in this module are derived from it.
 *
 * `bus` is a K-line bus when it has a `kline` key and a CAN bus otherwise. Unknown keys are ignored when loading; {@link checkProfile} reports them.
 */
export const profileFileSchema = object({
  notes: text().optional(),
  name: text(),
  description: text(),
  status: text(),
  bus: z.union([klineBusSchema, canBusSchema]),
  diagnostics: object({
    protocol: z.literal(PROFILE_PROTOCOLS, { error: wrong("kwp2000 or uds") }),
    session: whole(),
  }),
  units: z
    .record(z.string(), unitSchema)
    .refine((units) => Object.keys(units).length > 0, { error: "no units" }),
  codes: profileCodesSchema.optional(),
}).superRefine((file, context) => {
  const { protocol, session } = file.diagnostics;
  if ("kline" in file.bus) {
    for (const [unitName, unit] of Object.entries(file.units)) {
      if (unit.extended_address !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["units", unitName],
          message: "extended_address is ISO 15765-2 CAN addressing and a K-line bus has none",
        });
      }
      if (unit.id_bits !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["units", unitName],
          message: "id_bits is a CAN identifier width and a K-line bus has none",
        });
      }
    }
  }
  if ("kline" in file.bus && protocol !== "kwp2000") {
    context.addIssue({
      code: "custom",
      path: ["diagnostics"],
      message: `a K-line bus carries kwp2000 only, got ${JSON.stringify(protocol)}`,
    });
  }
  if (!isReadOnlySession(protocol, session)) {
    context.addIssue({
      code: "custom",
      path: ["diagnostics"],
      message: `diagnostic session ${hex(session, 2)} is not a read-only session`,
    });
  }
  for (const [unitName, unit] of Object.entries(file.units)) {
    for (const [valueName, value] of Object.entries(unit.values ?? {})) {
      if (value.identifier < 0 || value.identifier > MAX_IDENTIFIER[protocol]) {
        context.addIssue({
          code: "custom",
          path: ["units", unitName, "values", valueName],
          message: `identifier ${hex(value.identifier)} does not fit a ${protocol} identifier`,
        });
      }
    }
  }
  for (const [unit, code, message] of codeTableProblems(
    file.codes ?? {},
    new Set(Object.keys(file.units)),
  )) {
    context.addIssue({
      code: "custom",
      path: ["codes", unit, ...(code === undefined ? [] : [code])],
      message,
    });
  }
});

/** A profile file as parsed and validated, with the defaults applied. */
export type ProfileFile = z.output<typeof profileFileSchema>;

/** The width and rate of an ISO 15765-4 CAN bus. */
export interface CanBus {
  readonly kind: "can";
  readonly idBits: 11 | 29;
  readonly bitrate: number;
}

/**
 * A K-line bus: how the adapter initialises it and the addresses in the message headers.
 *
 * For a K-line unit, `Unit.requestId` is the unit's address (it is also the address sent in a slow initialisation) and `Unit.responseId` is the address its replies come from.
 */
export interface KLineBus {
  readonly kind: "kline";
  readonly scheme: KLineScheme;
  readonly tester: number;
  readonly headerFormat: number;
}

/**
 * One named value a unit reports: which identifier holds it and how its bytes become a number.
 *
 * `offset` and `size` pick the bytes out of the data that follows the identifier in the reply. The number is `raw * scale + bias`, where `raw` is those bytes read big-endian, signed when `signed` is set.
 */
export interface DataValue {
  readonly name: string;
  readonly label: string;
  readonly unit: string;
  readonly identifier: number;
  readonly offset: number;
  readonly size: number;
  readonly signed: boolean;
  readonly scale: number;
  readonly bias: number;
  readonly source: string;
  readonly status: string;
}

/**
 * One control unit: where to send requests and where its replies come from.
 *
 * `extendedAddress` is present for a unit reached with ISO 15765-2 extended addressing: the byte goes first in the data of every frame sent to the unit (requests and flow control), and every frame the unit sends starts with the tester address {@link DEFAULT_TESTER}. Several units may then share one request identifier, told apart by this byte.
 *
 * `idBits` is the width of the unit's CAN identifiers: the unit's own `id_bits` when the profile gives one, else the bus's, so a car that mixes 11-bit and 29-bit units names each one's width. A K-line unit has none.
 */
export interface Unit {
  readonly name: string;
  readonly description: string;
  readonly requestId: number;
  readonly responseId: number;
  readonly extendedAddress?: number;
  readonly idBits?: 11 | 29;
  readonly source: string;
  readonly values: ReadonlyMap<string, DataValue>;
}

/** Everything needed to talk to one chassis. */
export interface Profile {
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly bus: CanBus | KLineBus;
  readonly protocol: ProfileProtocol;
  readonly session: number;
  readonly units: ReadonlyMap<string, Unit>;
}

/** `0x`-prefixed lower-case hexadecimal, padded to at least `digits` digits. */
function hex(value: number, digits = 1): string {
  return `0x${value.toString(16).padStart(digits, "0")}`;
}

/**
 * Turns a reply's data bytes into the value: the `size` bytes at `offset` read big-endian, signed when the value is, then `raw * scale + bias`.
 *
 * Throws a `RangeError` when the reply is too short.
 */
export function decodeValue(value: DataValue, data: Uint8Array): number {
  const end = value.offset + value.size;
  if (data.length < end) {
    throw new RangeError(
      `${value.name}: reply holds ${String(data.length)} data bytes, ${String(end)} are needed`,
    );
  }
  let raw = 0;
  for (const byteValue of data.subarray(value.offset, end)) raw = raw * 256 + byteValue;
  const range = 256 ** value.size;
  if (value.signed && raw >= range / 2) raw -= range;
  return raw * value.scale + value.bias;
}

/** The CAN settings of a profile. Throws {@link ProfileError} for a K-line profile. */
export function canBus(profile: Profile): CanBus {
  if (profile.bus.kind !== "can") {
    throw new ProfileError([`profile ${profile.name} is a K-line profile and has no CAN settings`]);
  }
  return profile.bus;
}

/** Looks a unit up by name. Throws {@link ProfileError} listing the names when it is absent. */
export function profileUnit(profile: Profile, name: string): Unit {
  const unit = profile.units.get(name);
  if (unit === undefined) {
    throw new ProfileError([
      `profile ${profile.name} has no unit ${pythonRepr(name)}; it has ${[...profile.units.keys()].join(", ")}`,
    ]);
  }
  return unit;
}

/** The section of a profile file an issue at `path` belongs to, as it is named in error messages. */
function sectionLabel(where: string, path: readonly PropertyKey[]): string {
  const [first, unitName, third, valueName] = path.map(String);
  if (first === "bus" || first === "diagnostics") return `${where} [${first}]`;
  if (first === "units" && unitName !== undefined) {
    return third === "values" && valueName !== undefined
      ? `${where} [units.${unitName}.values.${valueName}]`
      : `${where} [units.${unitName}]`;
  }
  if (first === "codes" && unitName !== undefined) {
    return third === undefined
      ? `${where} [codes.${unitName}]`
      : `${where} [codes.${unitName}.${third}]`;
  }
  return where;
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current = data;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The leaf issues of a failed parse, resolving the bus union to the branch the data chose. */
function leafIssues(data: unknown, issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue): z.core.$ZodIssue[] => {
    if (issue.code !== "invalid_union") return [issue];
    const bus = valueAt(data, issue.path);
    const branch = typeof bus === "object" && bus !== null && "kline" in bus ? 0 : 1;
    const chosen = issue.errors[branch] ?? [];
    return leafIssues(
      data,
      chosen.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })),
    );
  });
}

/** One message per issue, each naming the section, then the field and what is wrong with it. */
function describeIssues(
  where: string,
  data: unknown,
  issues: readonly z.core.$ZodIssue[],
): string[] {
  return leafIssues(data, issues).flatMap((issue) => {
    if (issue.code === "custom") return [`${sectionLabel(where, issue.path)}: ${issue.message}`];
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${sectionLabel(where, issue.path)}: unknown key ${key}`);
    }
    const key = issue.path.at(-1);
    const section = sectionLabel(where, issue.path.slice(0, -1));
    if (key === undefined) return [`${where}: ${issue.message}`];
    return [
      issue.message === MISSING
        ? `${section}: missing ${String(key)}`
        : `${section}: ${String(key)} ${issue.message}`,
    ];
  });
}

function build(file: ProfileFile): Profile {
  const bus: CanBus | KLineBus =
    "kline" in file.bus
      ? {
          kind: "kline",
          scheme: file.bus.kline,
          tester: file.bus.tester ?? DEFAULT_TESTER,
          headerFormat: file.bus.header_format ?? KLINE_SCHEMES[file.bus.kline].headerFormat,
        }
      : { kind: "can", idBits: file.bus.id_bits, bitrate: file.bus.bitrate };
  const units = new Map<string, Unit>();
  for (const [unitName, unit] of Object.entries(file.units)) {
    const values = new Map<string, DataValue>();
    for (const [valueName, value] of Object.entries(unit.values ?? {})) {
      values.set(valueName, { name: valueName, ...value });
    }
    units.set(unitName, {
      name: unitName,
      description: unit.description,
      requestId: unit.request,
      responseId: unit.response,
      ...(unit.extended_address === undefined ? {} : { extendedAddress: unit.extended_address }),
      ...(bus.kind === "can" ? { idBits: unit.id_bits ?? bus.idBits } : {}),
      source: unit.source,
      values,
    });
  }
  return {
    name: file.name,
    description: file.description,
    status: file.status,
    bus,
    protocol: file.diagnostics.protocol,
    session: file.diagnostics.session,
    units,
  };
}

/**
 * Validates parsed profile JSON against {@link profileFileSchema}, returning the typed file or every problem found.
 *
 * `where` names the source in the problems. This is the validation both {@link parseProfile} and {@link checkProfile} start from.
 */
export function validateProfile(
  data: unknown,
  where: string,
):
  | { readonly file: ProfileFile; readonly problems?: undefined }
  | { readonly file?: undefined; readonly problems: string[] } {
  const parsed = profileFileSchema.safeParse(data);
  if (parsed.success) return { file: parsed.data };
  return { problems: describeIssues(where, data, parsed.error.issues) };
}

/**
 * Builds a {@link Profile} from parsed profile JSON. `where` names the source in error messages.
 *
 * Throws {@link ProfileError} for a missing or mistyped field, an identifier width or bit rate that is not valid CAN, or a diagnostic session the guard does not allow.
 */
export function parseProfile(data: unknown, where: string): Profile {
  const result = validateProfile(data, where);
  if (result.file === undefined) throw new ProfileError(result.problems);
  return build(result.file);
}

/**
 * Parses a profile's JSON text and builds a {@link Profile}. `where` names the source in error messages.
 *
 * Throws {@link ProfileError} when the text is not JSON, and as {@link parseProfile} otherwise.
 */
export function parseProfileText(text: string, where: string): Profile {
  return parseProfile(parseJson(text, where), where);
}

/** Parses JSON text, naming `where` in the {@link ProfileError} for text that is not JSON. */
export function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProfileError([`${where}: ${error.message}`]);
    throw error;
  }
}
