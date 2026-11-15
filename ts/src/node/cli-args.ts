/**
 * A small typed command-line parser that behaves as Python's `argparse` does for this tool's command set, so the argument names, defaults, conversions, exit statuses and error messages are the ones the Python command line had.
 *
 * `node:util` `parseArgs` is not used because it cannot express what the command line needs: it rejects an option value that starts with a dash (argparse accepts a negative number, and the commands then report the value as out of range with status 1, not as a usage error with status 2), it has no sub-commands, required options, choices or typed values, and its messages differ. A parser library would add a dependency for the same gaps. This module is the whole parser: a declarative {@link CommandSpec} in, a {@link ParsedArgs} or a {@link UsageError} out.
 */

import { fromHex } from "../core/bytes.js";
import { pythonRepr } from "../core/format.js";

/** How the text of an option or positional is converted. */
export type ValueKind =
  /** Text as given. */
  | "string"
  /** A decimal integer, as Python's `int(text)`. */
  | "int"
  /** A number, as Python's `float(text)`. */
  | "float"
  /** Hexadecimal, as Python's `int(text, 16)`. */
  | "hexInt"
  /** An integer in any Python literal base, as `int(text, 0)`. */
  | "autoInt"
  /** Bytes from pairs of hexadecimal digits, as `bytes.fromhex(text)`. */
  | "bytes";

/** What a converted value is. */
export type ArgValue =
  string | number | boolean | Uint8Array | readonly number[] | readonly string[];

interface ItemBase {
  /** The key the parsed value is read under. */
  readonly dest: string;
  /** What the option or positional means, for the help text. */
  readonly help: string;
  /** The name shown in usage and help in place of the value. */
  readonly metavar?: string;
}

/** An option: `--flag value`, `--flag=value`, a repeatable one, or a switch with no value. */
export interface OptionSpec extends ItemBase {
  /** The long flag, such as `--adapter`. */
  readonly flag: string;
  /** `flag` for a switch that takes no value. */
  readonly kind: ValueKind | "flag";
  /** The parse fails when the option is missing. */
  readonly required?: boolean;
  /** Each use adds to a list; for the text and integer kinds. */
  readonly repeat?: boolean;
  /** The only values allowed, compared after conversion. */
  readonly choices?: readonly (string | number)[];
  /** The value when the option is absent. */
  readonly default?: string | number;
}

/** A positional argument. */
export interface PositionalSpec extends ItemBase {
  readonly kind: ValueKind;
  /** `one` is required, `optional` may be absent, `one-or-more` and `any` collect a list. */
  readonly count: "one" | "optional" | "one-or-more" | "any";
}

/** One argument of a command, in the order it was declared. */
export type ArgSpec = OptionSpec | PositionalSpec;

/** One command, or a command group whose sub-commands carry the arguments. */
export interface CommandSpec {
  readonly name: string;
  /** One line shown in the command list. */
  readonly summary: string;
  /** Longer text shown above the arguments in the command's help. */
  readonly description?: string;
  readonly args: readonly ArgSpec[];
  /** Sub-commands, chosen by the first positional. A group has no arguments of its own. */
  readonly subcommands?: readonly CommandSpec[];
}

/** A command line the parser rejects: printed to the error stream with status 2. */
export class UsageError extends Error {
  override name = "UsageError";

  /**
   * @param usage The usage line of the command that rejected the arguments.
   * @param prog The command's full name, such as `obd-read probe`.
   * @param detail What was wrong.
   */
  constructor(
    readonly usage: string,
    readonly prog: string,
    detail: string,
  ) {
    super(detail);
  }

  /** The text written to the error stream: the usage line and the message. */
  get text(): string {
    return `${this.usage}\n${this.prog}: error: ${this.message}\n`;
  }
}

/** The text of `--help` for a command, to print with status 0. */
export class HelpRequested extends Error {
  override name = "HelpRequested";
}

/** The values a command line gave, read back with a typed accessor per kind. */
export class ParsedArgs {
  constructor(
    /** The command and sub-command names, such as `["profile", "check"]`. */
    readonly path: readonly string[],
    private readonly values: ReadonlyMap<string, ArgValue>,
  ) {}

  /** The text of an option or positional that is always present. */
  text(dest: string): string {
    const value = this.optionalText(dest);
    if (value === undefined) throw new Error(`argument ${dest} has no text value`);
    return value;
  }

  /** The text of an option or positional, or undefined when it was not given. */
  optionalText(dest: string): string | undefined {
    const value = this.values.get(dest);
    return typeof value === "string" ? value : undefined;
  }

  /** The number of an option or positional that is always present. */
  number(dest: string): number {
    const value = this.optionalNumber(dest);
    if (value === undefined) throw new Error(`argument ${dest} has no numeric value`);
    return value;
  }

  /** The number of an option or positional, or undefined when it was not given. */
  optionalNumber(dest: string): number | undefined {
    const value = this.values.get(dest);
    return typeof value === "number" ? value : undefined;
  }

  /** Whether a switch was given. */
  flag(dest: string): boolean {
    return this.values.get(dest) === true;
  }

  /** The bytes of an option that is always present. */
  bytes(dest: string): Uint8Array {
    const value = this.values.get(dest);
    if (!(value instanceof Uint8Array)) throw new Error(`argument ${dest} has no byte value`);
    return value;
  }

  /** The numbers of a repeatable option, empty when it was not given. */
  numbers(dest: string): readonly number[] {
    const value = this.values.get(dest);
    return Array.isArray(value) ? value.filter((item) => typeof item === "number") : [];
  }

  /** The texts of a repeatable option or a list positional, empty when none were given. */
  texts(dest: string): readonly string[] {
    const value = this.values.get(dest);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }
}

function isOption(spec: ArgSpec): spec is OptionSpec {
  return "flag" in spec;
}

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

/** Whether a word is an option rather than a value, as argparse decides it. */
function looksLikeOption(word: string): boolean {
  return word.startsWith("-") && word !== "-" && !NEGATIVE_NUMBER.test(word);
}

const DIGITS = "\\d+(?:_\\d+)*";

/** Python's `int(text)`, or undefined for text it would reject. */
function parseInteger(text: string): number | undefined {
  return new RegExp(`^\\s*[+-]?${DIGITS}\\s*$`).test(text)
    ? Number(text.trim().replaceAll("_", ""))
    : undefined;
}

/** Python's `int(text, 16)`, or undefined for text it would reject. */
function parseHexInteger(text: string): number | undefined {
  const match = /^\s*([+-]?)(?:0[xX])?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)\s*$/.exec(text);
  if (match === null) return undefined;
  const value = Number.parseInt((match[2] ?? "").replaceAll("_", ""), 16);
  return match[1] === "-" ? -value : value;
}

/** Python's `int(text, 0)`, or undefined for text it would reject. */
function parseAutoInteger(text: string): number | undefined {
  const match =
    /^\s*([+-]?)(0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0[oO][0-7]+(?:_[0-7]+)*|0[bB][01]+(?:_[01]+)*|0(?:_?0)*|[1-9](?:_?\d)*)\s*$/.exec(
      text,
    );
  if (match === null) return undefined;
  const body = (match[2] ?? "").replaceAll("_", "").toLowerCase();
  const value = body.startsWith("0o")
    ? Number.parseInt(body.slice(2), 8)
    : body.startsWith("0b")
      ? Number.parseInt(body.slice(2), 2)
      : Number(body);
  return match[1] === "-" ? -value : value;
}

/** Python's `float(text)`, or undefined for text it would reject. */
function parseFloating(text: string): number | undefined {
  const trimmed = text.trim().replaceAll("_", "");
  if (/^[+-]?(?:inf|infinity)$/i.test(trimmed))
    return trimmed.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(trimmed)) return Number.NaN;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** Python's `bytes.fromhex(text)`, which skips whitespace between pairs, or undefined. */
function parseBytes(text: string): Uint8Array | undefined {
  if (!/^[ \t\n\r\v\f]*(?:[0-9a-fA-F]{2}[ \t\n\r\v\f]*)*$/.test(text)) return undefined;
  return fromHex(text.replace(/[ \t\n\r\v\f]/g, ""));
}

/** The name argparse gives a converter in "invalid ... value" messages. */
const CONVERTER_NAME: Readonly<Record<ValueKind, string>> = {
  string: "str",
  int: "int",
  float: "float",
  hexInt: "<lambda>",
  autoInt: "<lambda>",
  bytes: "hexadecimal",
};

function convert(kind: ValueKind, text: string): string | number | Uint8Array | undefined {
  switch (kind) {
    case "string":
      return text;
    case "int":
      return parseInteger(text);
    case "float":
      return parseFloating(text);
    case "hexInt":
      return parseHexInteger(text);
    case "autoInt":
      return parseAutoInteger(text);
    case "bytes":
      return parseBytes(text);
  }
}

function displayName(spec: ArgSpec): string {
  return isOption(spec) ? spec.flag : (spec.metavar ?? spec.dest);
}

function metavarOf(spec: ArgSpec): string {
  if (spec.metavar !== undefined) return spec.metavar;
  return isOption(spec) ? spec.dest.replace(/([A-Z])/g, "_$1").toUpperCase() : spec.dest;
}

function optionUsage(spec: OptionSpec): string {
  const value =
    spec.kind === "flag"
      ? ""
      : ` ${spec.choices === undefined ? metavarOf(spec) : `{${spec.choices.join(",")}}`}`;
  return spec.required === true ? `${spec.flag}${value}` : `[${spec.flag}${value}]`;
}

function positionalUsage(spec: PositionalSpec): string {
  const name = metavarOf(spec);
  switch (spec.count) {
    case "one":
      return name;
    case "optional":
      return `[${name}]`;
    case "one-or-more":
      return `${name} [${name} ...]`;
    case "any":
      return `[${name} ...]`;
  }
}

/** The one-line usage of a command, as shown with a usage error. */
export function usageLine(prog: string, spec: CommandSpec): string {
  if (spec.subcommands !== undefined) {
    return `usage: ${prog} [-h] {${spec.subcommands.map((sub) => sub.name).join(",")}} ...`;
  }
  const parts = spec.args.map((arg) => (isOption(arg) ? optionUsage(arg) : positionalUsage(arg)));
  return `usage: ${prog} [-h] ${parts.join(" ")}`.trimEnd();
}

/** The help text of a command: usage, description, then each argument with its help. */
export function helpText(prog: string, spec: CommandSpec): string {
  const lines = [usageLine(prog, spec), ""];
  if (spec.description !== undefined) lines.push(spec.description, "");
  else lines.push(spec.summary, "");
  if (spec.subcommands !== undefined) {
    lines.push("commands:");
    for (const sub of spec.subcommands) lines.push(`  ${sub.name.padEnd(22)}${sub.summary}`);
    return `${lines.join("\n")}\n`;
  }
  const positionals = spec.args.filter((arg): arg is PositionalSpec => !isOption(arg));
  if (positionals.length > 0) {
    lines.push("positional arguments:");
    for (const arg of positionals) lines.push(`  ${metavarOf(arg).padEnd(22)}${arg.help}`);
    lines.push("");
  }
  lines.push("options:", `  ${"-h, --help".padEnd(22)}show this help message and exit`);
  for (const arg of spec.args) {
    if (!isOption(arg)) continue;
    const value =
      arg.kind === "flag"
        ? ""
        : ` ${arg.choices === undefined ? metavarOf(arg) : `{${arg.choices.join(",")}}`}`;
    const shown = `${arg.flag}${value}`;
    const fallback = arg.default === undefined ? "" : ` (default: ${String(arg.default)})`;
    lines.push(`  ${shown.padEnd(22)}${arg.help}${fallback}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The result of splitting the words of one command: options found and positionals left. */
interface Scan {
  readonly values: Map<string, ArgValue>;
  readonly positionals: string[];
  readonly unrecognised: string[];
}

function findOption(
  options: readonly OptionSpec[],
  word: string,
): { readonly option?: OptionSpec; readonly ambiguous?: readonly OptionSpec[] } {
  const exact = options.find((option) => option.flag === word);
  if (exact !== undefined) return { option: exact };
  const prefixed = options.filter((option) => option.flag.startsWith(word));
  const only = prefixed[0];
  if (prefixed.length === 1 && only !== undefined) return { option: only };
  if (prefixed.length > 1) return { ambiguous: prefixed };
  return {};
}

function scanWords(prog: string, spec: CommandSpec, words: readonly string[]): Scan {
  const usage = usageLine(prog, spec);
  const fail = (detail: string): never => {
    throw new UsageError(usage, prog, detail);
  };
  const options = spec.args.filter(isOption);
  const values = new Map<string, ArgValue>();
  const positionals: string[] = [];
  const unrecognised: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word === "--") {
      positionals.push(...words.slice(index + 1));
      break;
    }
    if (!looksLikeOption(word)) {
      positionals.push(word);
      continue;
    }
    if (word === "-h" || word === "--help") throw new HelpRequested(helpText(prog, spec));
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = equals < 0 ? word : word.slice(0, equals);
    const explicit = equals < 0 ? undefined : word.slice(equals + 1);
    const found = findOption(options, flag);
    if (found.ambiguous !== undefined) {
      fail(
        `ambiguous option: ${flag} could match ${found.ambiguous.map((o) => o.flag).join(", ")}`,
      );
    }
    const option = found.option;
    if (option === undefined) {
      unrecognised.push(word);
      continue;
    }
    if (option.kind === "flag") {
      if (explicit !== undefined) {
        fail(`argument ${option.flag}: ignored explicit argument ${pythonRepr(explicit)}`);
      }
      values.set(option.dest, true);
      continue;
    }
    let text = explicit;
    if (text === undefined) {
      const next = words[index + 1];
      if (next === undefined || looksLikeOption(next)) {
        fail(`argument ${option.flag}: expected one argument`);
      }
      text = next ?? "";
      index++;
    }
    const converted = convert(option.kind, text);
    if (converted === undefined) {
      fail(
        `argument ${option.flag}: invalid ${CONVERTER_NAME[option.kind]} value: ${pythonRepr(text)}`,
      );
    }
    if (
      converted !== undefined &&
      option.choices !== undefined &&
      !option.choices.some((choice) => choice === converted)
    ) {
      fail(
        `argument ${option.flag}: invalid choice: ${pythonRepr(text)} ` +
          `(choose from ${option.choices.join(", ")})`,
      );
    }
    if (converted === undefined) continue;
    if (option.repeat === true) {
      const earlier = values.get(option.dest);
      if (typeof converted === "number") {
        const list = Array.isArray(earlier)
          ? earlier.filter((item) => typeof item === "number")
          : [];
        values.set(option.dest, [...list, converted]);
      } else if (typeof converted === "string") {
        const list = Array.isArray(earlier)
          ? earlier.filter((item) => typeof item === "string")
          : [];
        values.set(option.dest, [...list, converted]);
      }
    } else {
      values.set(option.dest, converted);
    }
  }
  return { values, positionals, unrecognised };
}

/** Takes the positionals each declared argument claims, as argparse's greedy matching does. */
function claimPositionals(spec: CommandSpec, prog: string, scan: Scan): readonly PositionalSpec[] {
  const declared = spec.args.filter((arg): arg is PositionalSpec => !isOption(arg));
  const usage = usageLine(prog, spec);
  let next = 0;
  const missing: PositionalSpec[] = [];
  declared.forEach((arg, position) => {
    const later = declared.slice(position + 1);
    const reserved = later.filter((item) => item.count === "one" || item.count === "one-or-more");
    const available = scan.positionals.length - next - reserved.length;
    let take: number;
    if (arg.count === "one") take = 1;
    else if (arg.count === "optional") take = Math.max(0, Math.min(1, available));
    else if (arg.count === "one-or-more") take = Math.max(1, available);
    else take = Math.max(0, available);
    const words = scan.positionals.slice(next, next + take);
    if ((arg.count === "one" || arg.count === "one-or-more") && words.length < 1) {
      missing.push(arg);
      return;
    }
    next += words.length;
    const single = words[0];
    if (arg.count === "one" || arg.count === "optional") {
      if (single === undefined) return;
      const converted = convert(arg.kind, single);
      if (converted === undefined) {
        throw new UsageError(
          usage,
          prog,
          `argument ${displayName(arg)}: invalid ${CONVERTER_NAME[arg.kind]} value: ${pythonRepr(single)}`,
        );
      }
      scan.values.set(arg.dest, converted);
    } else if (words.length > 0) {
      scan.values.set(arg.dest, words);
    }
  });
  scan.unrecognised.push(...scan.positionals.slice(next));
  return missing;
}

/**
 * Parses the words of one command, choosing a sub-command first when the spec has any.
 *
 * @returns The values, with defaults filled in, and any words no argument claimed.
 * @throws UsageError for a missing or malformed argument.
 * @throws HelpRequested for `-h` or `--help`.
 */
function parseCommand(
  prog: string,
  spec: CommandSpec,
  words: readonly string[],
  path: readonly string[],
): { readonly args: ParsedArgs; readonly unrecognised: readonly string[] } {
  const usage = usageLine(prog, spec);
  if (spec.subcommands !== undefined) {
    const first = words.findIndex((word) => !looksLikeOption(word));
    const leading = words.slice(0, first < 0 ? words.length : first);
    if (leading.includes("-h") || leading.includes("--help")) {
      throw new HelpRequested(helpText(prog, spec));
    }
    const name = first < 0 ? undefined : words[first];
    if (name === undefined) {
      throw new UsageError(
        usage,
        prog,
        spec.name === "obd-read"
          ? "the following arguments are required: command"
          : "the following arguments are required: action",
      );
    }
    const sub = spec.subcommands.find((candidate) => candidate.name === name);
    if (sub === undefined) {
      const dest = spec.name === "obd-read" ? "command" : "action";
      throw new UsageError(
        usage,
        prog,
        `argument ${dest}: invalid choice: ${pythonRepr(name)} ` +
          `(choose from ${spec.subcommands.map((candidate) => candidate.name).join(", ")})`,
      );
    }
    const rest = [...words.slice(0, first), ...words.slice(first + 1)];
    const inner = parseCommand(`${prog} ${sub.name}`, sub, rest, [...path, sub.name]);
    return {
      args: inner.args,
      unrecognised: [...leading.filter(looksLikeOption), ...inner.unrecognised],
    };
  }
  const scan = scanWords(prog, spec, words);
  const missing = claimPositionals(spec, prog, scan);
  const required: string[] = [];
  for (const arg of spec.args) {
    if (isOption(arg)) {
      if (arg.required === true && !scan.values.has(arg.dest)) required.push(arg.flag);
      else if (arg.default !== undefined && !scan.values.has(arg.dest)) {
        scan.values.set(arg.dest, arg.default);
      }
    } else if (missing.includes(arg)) {
      required.push(displayName(arg));
    }
  }
  if (required.length > 0) {
    throw new UsageError(
      usage,
      prog,
      `the following arguments are required: ${required.join(", ")}`,
    );
  }
  return { args: new ParsedArgs(path, scan.values), unrecognised: scan.unrecognised };
}

/**
 * Parses a whole command line against the program's commands.
 *
 * @param program The root spec: its `subcommands` are the commands.
 * @param argv The words after the program name.
 * @throws UsageError for a command line the commands reject, with the program's own usage for words no command claimed.
 * @throws HelpRequested for `-h` or `--help` at any level.
 */
export function parseCommandLine(program: CommandSpec, argv: readonly string[]): ParsedArgs {
  const parsed = parseCommand(program.name, program, argv, []);
  if (parsed.unrecognised.length > 0) {
    throw new UsageError(
      usageLine(program.name, program),
      program.name,
      `unrecognized arguments: ${parsed.unrecognised.join(" ")}`,
    );
  }
  return parsed.args;
}
