/**
 * The one place where the TypeScript command line's output is allowed to differ from the Python command line's, and the only place the parity suite rewrites anything. Every rule is a difference the port makes on purpose or the platform imposes; anything else must match byte for byte, including stdout, stderr, the exit status and every file written.
 *
 * 1. Profile files are JSON, not TOML. A scenario names a profile file as `@profile:<name>`; Python reads and writes `<name>.toml` and TypeScript `<name>.json`. In output text and file names, `<name>.json` becomes `<name>.toml`. A draft profile written by `discover` is compared as a parsed document (TOML against JSON); the JSON draft carries its explanation in a `notes` key where the TOML draft has comments, so `notes` is dropped from the JSON side.
 * 2. A usage error (status 2) prints argparse's usage block, whose wrapping the port does not reproduce. Only the last line, the `obd-read <command>: error: ...` message, is compared, and the usage block is dropped from both sides.
 * 4. `adapters --inspect` prints the `service` line of each characteristic in Python, so a service
 *    with several characteristics repeats it; TypeScript prints it once per service. Consecutive
 *    repeated `service` lines in Python's output are collapsed.
 * 3. `simulate` listens on an operating-system port when asked for port 0, so the port in its banner is replaced by `<port>`.
 */

import { parse } from "smol-toml";
import type { Golden } from "./scenarios.js";

/** What one side printed and wrote, in the form the two sides are compared in. */
export interface Observed {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Plain files as text, TOML or JSON drafts as parsed documents. */
  readonly files: Readonly<Record<string, string | { readonly document: unknown }>>;
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

function dropUsage(stderr: string, exit: number): string {
  return exit === 2 ? `${lastLine(stderr)}\n` : stderr;
}

function collapseServices(text: string): string {
  let current: string | undefined;
  return text
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("  service ")) return true;
      const repeated = line === current;
      current = line;
      return !repeated;
    })
    .join("\n");
}

function maskPort(text: string): string {
  return text.replaceAll(/tcp:\/\/127\.0\.0\.1:\d+/g, "tcp://127.0.0.1:<port>");
}

/** Whether `value` is a plain object, for dropping the JSON draft's `notes`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What Python did, as compared: its draft profiles parsed from TOML.
 *
 * @param golden The recorded behaviour.
 */
export function observedPython(golden: Golden): Observed {
  const files: Record<string, string | { document: unknown }> = {};
  for (const [name, text] of Object.entries(golden.files)) {
    files[name] = name.endsWith(".toml") ? { document: parse(text) } : text;
  }
  return {
    exit: golden.exit,
    stdout: collapseServices(maskPort(golden.stdout)),
    stderr: dropUsage(golden.stderr, golden.exit),
    files,
  };
}

/**
 * What TypeScript did, as compared: `<name>.json` profile names are shown as `<name>.toml`, and its draft profiles are compared as parsed JSON without `notes`.
 *
 * @param profileNames The profile files the scenario names, without suffix.
 */
export function observedTypeScript(
  observed: {
    readonly exit: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly files: Readonly<Record<string, string>>;
  },
  profileNames: readonly string[],
): Observed {
  const rename = (text: string): string =>
    profileNames.reduce((result, name) => result.replaceAll(`${name}.json`, `${name}.toml`), text);
  const files: Record<string, string | { document: unknown }> = {};
  for (const [name, text] of Object.entries(observed.files)) {
    const renamed = rename(name);
    if (renamed.endsWith(".toml")) {
      const document: unknown = JSON.parse(text);
      if (isRecord(document)) delete document.notes;
      files[renamed] = { document };
    } else {
      files[renamed] = text;
    }
  }
  return {
    exit: observed.exit,
    stdout: maskPort(rename(observed.stdout)),
    stderr: dropUsage(rename(observed.stderr), observed.exit),
    files,
  };
}
