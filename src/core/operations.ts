/**
 * What the commands do with a connected adapter: read a unit, scan a car, clear a unit.
 *
 * Nothing here touches a file or a process global. Saved snapshots go through a
 * {@link WritableSnapshotStore}, scan reports through {@link OutputFiles}, and output through a
 * {@link LineSink}, each of which a platform supplies.
 */

import { actuateCommand, type Sleep } from "./actuate.js";
import { hexNumber, fromHex, toUpperHex } from "./bytes.js";
import { NegativeResponse } from "./diag.js";
import { ElmError, NoResponse, type AdapterInfo, type Elm } from "./elm.js";
import { pythonRepr } from "./format.js";
import { GuardError, authoriseClear } from "./guard.js";
import { selectBus } from "./kline.js";
import { jsonText, type JsonValue } from "./ordered-json.js";
import { OptionError } from "./options.js";
import { profileUnit, type Profile, type Unit } from "./profile.js";
import { isoNowSeconds } from "./time.js";
import { makeClient, unitSession, type LineSink, type UnitProfile } from "./unit-access.js";
import { writeCommand, type WriteCommand, type WritableSnapshotStore } from "./writes.js";

/** The parts of a unit a report names. */
export type ReportUnit = Pick<
  Unit,
  "name" | "description" | "requestId" | "responseId" | "extendedAddress"
>;

/** One stored fault code in a report: the code and its status byte as two hexadecimal digits. */
export interface ReportFault {
  readonly code: string;
  readonly status: string;
}

/** One identification value in a report: its bytes as hexadecimal and its printable text. */
export interface ReportIdent {
  readonly hex: string;
  readonly text: string;
}

/** What one control unit said, in plain values that serialise to JSON. */
export interface UnitReport {
  readonly unit: string;
  readonly description: string;
  /** The request identifier as upper-case hexadecimal. */
  readonly requestId: string;
  /** The response identifier as upper-case hexadecimal. */
  readonly responseId: string;
  answered: boolean;
  readonly notes: string[];
  /** Each identification value by label, in the order the unit gave them. */
  readonly identification: Map<string, ReportIdent>;
  /** The stored fault codes, or `null` when they were not read. */
  faults: ReportFault[] | null;
  /** The raw freeze frame, or why there is none, by fault code. */
  readonly freezeFrames: Map<string, string>;
}

/** The result of one clear command. */
export interface ClearOutcome {
  readonly before: UnitReport;
  readonly cleared: boolean;
  /** The unit read again after the clear; `null` when nothing was cleared. */
  readonly after: UnitReport | null;
}

/** The clear command stopped before sending anything that changes the car. */
export class ClearRefused extends Error {
  override name = "ClearRefused";
}

/** What {@link readUnit} reads beyond the identification. */
export interface ReadOptions {
  /** Also read the stored fault codes. */
  readonly faults: boolean;
  /** Also read the freeze frame stored with each fault code; needs `faults`. */
  readonly freeze: boolean;
}

/**
 * Addresses one unit and reads its identification, and optionally its faults and freeze frames.
 *
 * A unit that stays silent or refuses a request is reported, not thrown: the report's `answered`
 * flag and `notes` say what happened.
 */
export async function readUnit(
  elm: Elm,
  profile: UnitProfile,
  unit: ReportUnit,
  options: ReadOptions,
): Promise<UnitReport> {
  const report: UnitReport = {
    unit: unit.name,
    description: unit.description,
    requestId: hexNumber(unit.requestId, 1),
    responseId: hexNumber(unit.responseId, 1),
    answered: false,
    notes: [],
    identification: new Map(),
    faults: null,
    freezeFrames: new Map(),
  };
  await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
  const client = makeClient(elm, profile, unit);
  try {
    await client.start();
    report.answered = true;
  } catch (error) {
    if (error instanceof NoResponse) {
      report.notes.push("no answer to the session request");
      return report;
    }
    if (error instanceof NegativeResponse) {
      report.answered = true;
      report.notes.push(`session request refused: ${error.message}`);
    } else if (error instanceof ElmError) {
      report.notes.push(`session request failed: ${error.message}`);
      return report;
    } else {
      throw error;
    }
  }

  try {
    for (const item of await client.identification()) {
      report.identification.set(item.label, { hex: toUpperHex(item.raw), text: item.text });
    }
  } catch (error) {
    if (!(error instanceof NegativeResponse || error instanceof ElmError)) throw error;
    report.notes.push(`identification not read: ${error.message}`);
  }

  if (!options.faults) return report;
  let stored;
  try {
    stored = await client.faults();
  } catch (error) {
    if (!(error instanceof NegativeResponse || error instanceof ElmError)) throw error;
    report.notes.push(`fault codes not read: ${error.message}`);
    return report;
  }
  report.faults = stored.map((fault) => ({ code: fault.code, status: hexNumber(fault.status, 2) }));

  if (options.freeze) {
    for (const fault of stored) {
      try {
        report.freezeFrames.set(fault.code, toUpperHex(await client.freezeFrame(fault)));
      } catch (error) {
        if (error instanceof NoResponse) {
          report.freezeFrames.set(fault.code, "no answer");
        } else if (error instanceof NegativeResponse || error instanceof ElmError) {
          report.freezeFrames.set(fault.code, `not read: ${error.message}`);
        } else {
          throw error;
        }
      }
    }
  }
  return report;
}

/** Reads every unit in the profile, one after another. */
export async function scan(
  elm: Elm,
  profile: Profile,
  options: ReadOptions,
): Promise<UnitReport[]> {
  const reports: UnitReport[] = [];
  for (const unit of profile.units.values()) {
    reports.push(await readUnit(elm, profile, unit, options));
  }
  return reports;
}

/** One unit report as the JSON object the saved documents hold. */
function unitJson(report: UnitReport): JsonValue {
  return new Map<string, JsonValue>([
    ["unit", report.unit],
    ["description", report.description],
    ["request_id", report.requestId],
    ["response_id", report.responseId],
    ["answered", report.answered],
    ["notes", report.notes],
    [
      "identification",
      new Map(
        Array.from(report.identification, ([label, value]): [string, JsonValue] => [
          label,
          new Map<string, JsonValue>([
            ["hex", value.hex],
            ["text", value.text],
          ]),
        ]),
      ),
    ],
    [
      "faults",
      report.faults === null
        ? null
        : report.faults.map(
            (fault) =>
              new Map<string, JsonValue>([
                ["code", fault.code],
                ["status", fault.status],
              ]),
          ),
    ],
    ["freeze_frames", new Map<string, JsonValue>(report.freezeFrames)],
  ]);
}

/** What the adapter said about itself, as the saved documents record it. */
export function adapterJson(adapter: AdapterInfo): JsonValue {
  return new Map<string, JsonValue>([
    ["identity", adapter.identity],
    ["description", adapter.description],
    ["stn_identity", adapter.stnIdentity],
    ["voltage", adapter.voltage],
  ]);
}

/** A saved scan or snapshot: when it was taken and the JSON that records it. */
export interface ScanDocument {
  /** The time it was taken, ISO 8601 to the second with a `+00:00` offset. */
  readonly taken: string;
  readonly json: JsonValue;
}

/** The saved form of a scan or snapshot: what was read, from what, and the raw exchange. */
export function scanDocument(
  profile: Pick<Profile, "name" | "status">,
  adapter: AdapterInfo,
  units: readonly UnitReport[],
  transcript: readonly string[],
): ScanDocument {
  const taken = isoNowSeconds();
  return {
    taken,
    json: new Map<string, JsonValue>([
      ["tool", "obd-read"],
      ["taken", taken],
      [
        "profile",
        new Map<string, JsonValue>([
          ["name", profile.name],
          ["status", profile.status],
        ]),
      ],
      ["adapter", adapterJson(adapter)],
      ["units", units.map(unitJson)],
      ["transcript", [...transcript]],
    ]),
  };
}

/** A scan as a Markdown report: one summary table, then each unit's details. */
export function renderMarkdown(
  profile: Pick<Profile, "name" | "status">,
  taken: string,
  units: readonly UnitReport[],
): string {
  const lines = [
    "# obd-read scan",
    "",
    `Taken ${taken} with profile \`${profile.name}\` (address table ${profile.status}).`,
    "",
    "| Unit | Answered | Fault codes |",
    "|---|---|---|",
  ];
  for (const unit of units) {
    const count = unit.faults === null ? "not read" : String(unit.faults.length);
    lines.push(`| ${unit.unit} | ${unit.answered ? "yes" : "no"} | ${count} |`);
  }
  for (const unit of units) {
    lines.push("", `## ${unit.unit}`, "", unit.description, "");
    lines.push(`Request ${unit.requestId}, reply ${unit.responseId}.`);
    for (const [label, value] of unit.identification) {
      lines.push(`- ${label}: \`${value.hex}\` (${value.text})`);
    }
    for (const fault of unit.faults ?? []) {
      const frame = unit.freezeFrames.get(fault.code);
      const suffix = frame === undefined || frame === "" ? "" : `, freeze frame \`${frame}\``;
      lines.push(`- fault \`${fault.code}\`, status \`${fault.status}\`${suffix}`);
    }
    for (const note of unit.notes) lines.push(`- note: ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

/** What {@link clearUnit} needs. */
export interface ClearUnitParams {
  readonly elm: Elm;
  readonly profile: Profile;
  readonly adapter: AdapterInfo;
  readonly unit: Unit;
  readonly store: WritableSnapshotStore;
  /** The name of the new snapshot the unit's fault codes and freeze frames are saved to. */
  readonly save: string;
  /** Asked with what was read and saved; returns whether to erase the codes. */
  readonly confirm: (before: UnitReport) => Promise<boolean>;
}

/**
 * Saves a unit's fault codes and freeze frames, then erases its fault codes.
 *
 * The order is fixed: read, write the snapshot to `save`, ask `confirm`, clear, read again. When
 * `confirm` returns false the snapshot stays and the outcome reports that nothing was cleared.
 *
 * @throws ClearRefused, having sent nothing that changes the car, when `save` already exists or the
 * unit's codes cannot be read.
 * @throws GuardError when the snapshot has gone by the time the clear is sent.
 */
export async function clearUnit(params: ClearUnitParams): Promise<ClearOutcome> {
  const { elm, profile, adapter, unit, store, save, confirm } = params;
  if (await store.exists(save)) {
    throw new ClearRefused(`${save} already exists; choose a new file for the snapshot`);
  }
  const before = await readUnit(elm, profile, unit, { faults: true, freeze: true });
  if (before.faults === null) {
    throw new ClearRefused(
      `could not read ${unit.name}'s fault codes (${before.notes.join("; ")}); nothing cleared`,
    );
  }
  const saved = scanDocument(profile, adapter, [before], elm.transcript.entries);
  await store.create(save, `${jsonText(saved.json)}\n`);
  const token = await authoriseClear(store, save);
  if (!(await confirm(before))) return { before, cleared: false, after: null };
  await makeClient(elm, profile, unit).clear(token);
  const after = await readUnit(elm, profile, unit, { faults: true, freeze: false });
  return { before, cleared: true, after };
}

/** Prints one unit's report as indented plain text. */
export function printUnit(report: UnitReport, out: LineSink): void {
  const state = report.answered ? "answered" : "no answer";
  out(`${report.unit} (${report.requestId} -> ${report.responseId}): ${state}`);
  for (const [label, value] of report.identification) {
    out(`  ${label}: ${value.hex}  ${value.text}`);
  }
  if (report.faults !== null) {
    out(`  fault codes: ${String(report.faults.length)}`);
    for (const fault of report.faults) {
      out(`    ${fault.code}  status ${fault.status}`);
      const frame = report.freezeFrames.get(fault.code);
      if (frame !== undefined) out(`      freeze frame: ${frame}`);
    }
  }
  for (const note of report.notes) out(`  note: ${note}`);
}

/** Prints the two lines every command that connects starts with: the adapter and its extensions. */
export function printAdapter(adapter: AdapterInfo, out: LineSink): void {
  const voltage =
    adapter.voltage === null || adapter.voltage === "" ? "not reported" : adapter.voltage;
  out(`adapter: ${adapter.identity}, battery ${voltage}`);
  const extensions =
    adapter.stnIdentity === null || adapter.stnIdentity === ""
      ? "none (plain ELM327 command set)"
      : adapter.stnIdentity;
  out(`STN extensions: ${extensions}`);
}

/**
 * Where a scan's report files go. A platform supplies it (files in Node, downloads in a page).
 * Unlike a snapshot, a report is not evidence of what was erased, so a write replaces a file of
 * the same name.
 */
export interface OutputFiles {
  /** Writes `text` under `name`, replacing any earlier file of that name. */
  write(name: string, text: string): Promise<void>;
}

/**
 * The path with its last suffix replaced, as Python's `Path.with_suffix` does: `scan.x` becomes
 * `scan.json` and `scan` becomes `scan.json`.
 *
 * @throws OptionError when the path names no file.
 */
export function withSuffix(path: string, suffix: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(separator + 1);
  if (name === "") throw new OptionError(`${pythonRepr(path)} has an empty name`);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  return `${path.slice(0, separator + 1)}${stem}${suffix}`;
}

/**
 * Bytes from hexadecimal text, skipping ASCII whitespace between the byte pairs.
 *
 * @throws GuardError when the text is not hexadecimal bytes.
 */
export function requestBytes(text: string): Uint8Array {
  if (!/^[ \t\n\r\v\f]*([0-9a-fA-F]{2}[ \t\n\r\v\f]*)*$/.test(text)) {
    throw new GuardError(`request is not hexadecimal bytes: ${pythonRepr(text)}`);
  }
  return fromHex(text.replace(/[ \t\n\r\v\f]/g, ""));
}

/** Reads one unit: its identification, its fault codes, or its fault codes with freeze frames. */
export type UnitReadCommand = {
  readonly [Name in "ident" | "faults" | "freeze"]: {
    readonly command: Name;
    readonly unit: string;
  };
}["ident" | "faults" | "freeze"];

/** A command for a profile's units. */
export type ProfileCommand =
  | { readonly command: "probe" }
  | {
      readonly command: "scan";
      /** Also read freeze frames. */
      readonly freeze: boolean;
      /** The path the `.json` and `.md` reports are written beside, without a suffix. */
      readonly output?: string;
    }
  | UnitReadCommand
  | { readonly command: "request"; readonly unit: string; readonly request: string }
  | {
      readonly command: "clear";
      readonly unit: string;
      readonly save: string;
      /** Do not ask before clearing. */
      readonly yes: boolean;
    }
  | (WriteCommand & { readonly unit: string; readonly save: string })
  | {
      readonly command: "actuate";
      readonly unit: string;
      readonly request: Uint8Array;
      readonly stop: Uint8Array;
      readonly durationMs: number;
      readonly sleep?: Sleep;
    };

/** What {@link profileCommand} needs beside the command itself. */
export interface ProfileCommandParams {
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
  readonly profile: Profile;
  /** Where snapshots are saved, refusing to replace one. */
  readonly store: WritableSnapshotStore;
  /** Where a scan's `.json` and `.md` reports go; needed only for `scan` with an output. */
  readonly files?: OutputFiles;
  readonly out: LineSink;
  /** Shows a prompt and returns what the user typed. */
  readonly ask: (prompt: string) => Promise<string>;
}

/**
 * Runs a command against a profile's units: selects the bus, notes an unconfirmed address table,
 * then probes, scans, reads, sends one request, clears, writes or actuates.
 *
 * @returns The exit status: 0 when the command did what was asked, 1 when a unit stayed silent or
 * a clear was declined.
 * @throws ProfileError for a unit the profile does not have.
 * @throws GuardError for a request the guard refuses, before anything is sent.
 * @throws ClearRefused, WriteRefused, ActuationError, NegativeResponse and ElmError as the
 * underlying operations do.
 */
export async function profileCommand(
  command: ProfileCommand,
  params: ProfileCommandParams,
): Promise<number> {
  const { elm, adapter, profile, store, files, out, ask } = params;
  await selectBus(elm, profile);
  if (profile.status !== "confirmed") {
    out(`profile ${profile.name}: address table is ${profile.status}`);
  }

  if (command.command === "probe" || command.command === "scan") {
    const withFaults = command.command === "scan";
    const reports = await scan(elm, profile, {
      faults: withFaults,
      freeze: withFaults && command.freeze,
    });
    for (const report of reports) printUnit(report, out);
    const answered = reports.filter((report) => report.answered).length;
    out(`${String(answered)} of ${String(reports.length)} units answered`);
    if (withFaults && command.output !== undefined) {
      if (files === undefined) throw new OptionError("a scan report needs somewhere to write to");
      const saved = scanDocument(profile, adapter, reports, elm.transcript.entries);
      const jsonPath = withSuffix(command.output, ".json");
      const markdownPath = withSuffix(command.output, ".md");
      await files.write(jsonPath, `${jsonText(saved.json)}\n`);
      await files.write(markdownPath, renderMarkdown(profile, saved.taken, reports));
      out(`wrote ${jsonPath} and ${markdownPath}`);
    }
    return 0;
  }

  const unit = profileUnit(profile, command.unit);
  if (command.command === "write" || command.command === "restore") {
    return writeCommand(command, {
      elm,
      adapter,
      profile,
      unit,
      store,
      save: command.save,
      out,
      ask,
    });
  }
  if (command.command === "actuate") {
    return actuateCommand({
      elm,
      profile,
      unit,
      request: command.request,
      stop: command.stop,
      durationMs: command.durationMs,
      out,
      ask,
      ...(command.sleep === undefined ? {} : { sleep: command.sleep }),
    });
  }
  if (command.command === "ident" || command.command === "faults" || command.command === "freeze") {
    const report = await readUnit(elm, profile, unit, {
      faults: command.command !== "ident",
      freeze: command.command === "freeze",
    });
    printUnit(report, out);
    return report.answered ? 0 : 1;
  }

  if (command.command === "request") {
    const payload = requestBytes(command.request);
    await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress);
    const reply = await unitSession(elm, profile, unit).request(payload);
    out(toUpperHex(reply));
    return 0;
  }

  const confirm = async (before: UnitReport): Promise<boolean> => {
    printUnit(before, out);
    out(`snapshot saved to ${command.save}`);
    if (command.yes) return true;
    return (
      (await ask(`Erase these fault codes from ${unit.name}? Type yes to continue: `)) === "yes"
    );
  };
  const outcome = await clearUnit({
    elm,
    profile,
    adapter,
    unit,
    store,
    save: command.save,
    confirm,
  });
  if (!outcome.cleared || outcome.after === null) {
    out("nothing cleared");
    return 1;
  }
  out("cleared; reading the unit again:");
  printUnit(outcome.after, out);
  return 0;
}
