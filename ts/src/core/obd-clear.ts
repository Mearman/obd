/**
 * Clears emissions fault codes on the profile-free OBD-II path, with the snapshot saved first.
 *
 * Mode 04 erases the stored codes, freeze frame and misfire data of every emissions-related unit on
 * the bus and resets their readiness monitors. It is sent only through the guard's clear token, and
 * only after what it erases is on disk.
 */

import { hexNumber } from "./bytes.js";
import { NEGATIVE_RESPONSE, POSITIVE_OFFSET } from "./diag.js";
import { ElmError, type AdapterInfo, type Elm } from "./elm.js";
import { DiagProtocol, authoriseClear, permit, type ClearToken } from "./guard.js";
import { jsonText, type JsonValue } from "./ordered-json.js";
import {
  FUNCTIONAL_ID,
  PENDING_CODES,
  PERMANENT_CODES,
  STORED_CODES,
  codes,
  freezeFrame,
  misfireCounts,
  readiness,
  vin,
  type MisfireCounts,
} from "./obd.js";
import { ClearRefused, adapterJson } from "./operations.js";
import { isoNowSeconds } from "./time.js";
import type { LineSink } from "./unit-access.js";
import type { WritableSnapshotStore } from "./writes.js";

/** The OBD-II service that clears fault codes. */
export const CLEAR_MODE = 0x04;

/** One unit's warning-lamp state and stored-code count, as saved. */
export interface ReadinessRecord {
  readonly lampOn: boolean;
  readonly codeCount: number;
}

/** The fault code a unit froze its data for, and the values stored with it, as saved. */
export interface FreezeRecord {
  readonly code: string | null;
  readonly values: ReadonlyMap<string, string>;
}

/**
 * Everything mode 04 is about to erase that the legislated reads can report, in plain values. Each
 * map is keyed by the sender's identifier as upper-case hexadecimal.
 */
export interface ObdSnapshot {
  vin: string | null;
  readiness: Map<string, ReadinessRecord>;
  stored: Map<string, string[]>;
  pending: Map<string, string[]>;
  permanent: Map<string, string[]>;
  freezeFrames: Map<string, FreezeRecord>;
  misfireCounts: Map<string, MisfireCounts[]>;
  notes: string[];
}

/** The result of one clear-codes command. */
export interface ObdClearOutcome {
  readonly before: ObdSnapshot;
  readonly cleared: boolean;
  /** The codes read again after the clear; `null` when nothing was cleared. */
  readonly after: ObdSnapshot | null;
}

function byUnit<Value>(found: ReadonlyMap<number, Value>): Map<string, Value> {
  return new Map(Array.from(found, ([sender, value]) => [hexNumber(sender, 1), value]));
}

/**
 * Reads the codes and readiness state, and with `full` the VIN, freeze frames and misfire counts.
 *
 * @throws ElmError when the stored or pending codes cannot be read, or when no unit reports stored
 * codes: nothing may be erased that was not first read. A permanent code, freeze frame or misfire
 * read that fails is recorded in `notes`, since those are optional reads on many cars.
 */
export async function readSnapshot(
  elm: Elm,
  options: { readonly full: boolean },
): Promise<ObdSnapshot> {
  const snapshot: ObdSnapshot = {
    vin: null,
    readiness: new Map(),
    stored: new Map(),
    pending: new Map(),
    permanent: new Map(),
    freezeFrames: new Map(),
    misfireCounts: new Map(),
    notes: [],
  };
  const stored = await codes(elm, STORED_CODES);
  if (stored.size === 0) throw new ElmError("no unit reported its stored codes");
  snapshot.stored = byUnit(stored);
  snapshot.pending = byUnit(await codes(elm, PENDING_CODES));
  snapshot.readiness = byUnit(
    new Map(
      Array.from(await readiness(elm), ([sender, state]) => [
        sender,
        { lampOn: state.lampOn, codeCount: state.codeCount },
      ]),
    ),
  );
  if (!options.full) return snapshot;
  snapshot.vin = (await vin(elm)) ?? null;
  try {
    snapshot.permanent = byUnit(await codes(elm, PERMANENT_CODES));
  } catch (error) {
    if (!(error instanceof ElmError)) throw error;
    snapshot.notes.push(`permanent codes not read: ${error.message}`);
  }
  try {
    snapshot.freezeFrames = byUnit(
      new Map(
        Array.from(await freezeFrame(elm), ([sender, frame]) => [
          sender,
          { code: frame.code, values: frame.values },
        ]),
      ),
    );
  } catch (error) {
    if (!(error instanceof ElmError)) throw error;
    snapshot.notes.push(`freeze frame not read: ${error.message}`);
  }
  try {
    snapshot.misfireCounts = byUnit(await misfireCounts(elm));
  } catch (error) {
    if (!(error instanceof ElmError)) throw error;
    snapshot.notes.push(`misfire counts not read: ${error.message}`);
  }
  return snapshot;
}

function codesJson(found: ReadonlyMap<string, readonly string[]>): JsonValue {
  return new Map<string, JsonValue>(Array.from(found, ([sender, list]) => [sender, [...list]]));
}

/** A snapshot as the JSON object the saved document holds, keys in the order the Python tool wrote. */
export function snapshotJson(snapshot: ObdSnapshot): JsonValue {
  return new Map<string, JsonValue>([
    ["vin", snapshot.vin],
    [
      "readiness",
      new Map<string, JsonValue>(
        Array.from(snapshot.readiness, ([sender, state]) => [
          sender,
          new Map<string, JsonValue>([
            ["lamp_on", state.lampOn],
            ["code_count", state.codeCount],
          ]),
        ]),
      ),
    ],
    ["stored", codesJson(snapshot.stored)],
    ["pending", codesJson(snapshot.pending)],
    ["permanent", codesJson(snapshot.permanent)],
    [
      "freeze_frames",
      new Map<string, JsonValue>(
        Array.from(snapshot.freezeFrames, ([sender, frame]) => [
          sender,
          new Map<string, JsonValue>([
            ["code", frame.code],
            ["values", new Map<string, JsonValue>(frame.values)],
          ]),
        ]),
      ),
    ],
    [
      "misfire_counts",
      new Map<string, JsonValue>(
        Array.from(snapshot.misfireCounts, ([sender, monitors]) => [
          sender,
          monitors.map(
            (counts) =>
              new Map<string, JsonValue>([
                ["monitor", counts.monitor],
                ["average_last_ten_cycles", counts.averageLastTenCycles ?? null],
                ["last_cycle", counts.lastCycle ?? null],
              ]),
          ),
        ]),
      ),
    ],
    ["notes", snapshot.notes],
  ]);
}

/**
 * Sends mode 04 to every unit and returns the senders that confirmed the clear.
 *
 * @throws GuardError when the token's snapshot has gone.
 * @throws ElmError when a unit refuses the clear or none confirms it.
 */
export async function sendClear(elm: Elm, token: ClearToken): Promise<number[]> {
  const replies = await elm.request(
    await permit(DiagProtocol.OBD, Uint8Array.of(CLEAR_MODE), token),
  );
  const confirmed: number[] = [];
  for (const [sender, messages] of replies) {
    for (const message of messages) {
      const [service, , code] = message;
      if (service === CLEAR_MODE + POSITIVE_OFFSET) {
        confirmed.push(sender);
      } else if (service === NEGATIVE_RESPONSE && code !== undefined) {
        throw new ElmError(
          `unit ${hexNumber(sender, 1)} refused the clear with code ${hexNumber(code, 2)}`,
        );
      }
    }
  }
  if (confirmed.length === 0) throw new ElmError("no unit confirmed the clear");
  return confirmed;
}

/** What {@link clearCodes} needs. */
export interface ClearCodesParams {
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
  readonly store: WritableSnapshotStore;
  /** The name of the new snapshot the codes are saved to. */
  readonly save: string;
  /** Asked with what was read and saved; returns whether to erase it. */
  readonly confirm: (before: ObdSnapshot) => Promise<boolean>;
}

/**
 * Saves what mode 04 will erase, asks `confirm`, sends the clear, then reads the codes again.
 *
 * The functional address must already be selected. When `confirm` returns false the snapshot stays
 * and the outcome reports nothing cleared.
 *
 * @throws ClearRefused, having sent nothing that changes the car, when `save` already exists or the
 * codes cannot be read.
 * @throws GuardError when the snapshot has gone by the time the clear is sent.
 * @throws ElmError when a unit refuses the clear or none confirms it.
 */
export async function clearCodes(params: ClearCodesParams): Promise<ObdClearOutcome> {
  const { elm, adapter, store, save, confirm } = params;
  if (await store.exists(save)) {
    throw new ClearRefused(`${save} already exists; choose a new file for the snapshot`);
  }
  let before: ObdSnapshot;
  try {
    before = await readSnapshot(elm, { full: true });
  } catch (error) {
    if (!(error instanceof ElmError)) throw error;
    throw new ClearRefused(`could not read the fault codes (${error.message}); nothing cleared`, {
      cause: error,
    });
  }
  const saved = new Map<string, JsonValue>([
    ["tool", "obd-read"],
    ["taken", isoNowSeconds()],
    ["adapter", adapterJson(adapter)],
    ["snapshot", snapshotJson(before)],
    ["transcript", [...elm.transcript.entries]],
  ]);
  await store.create(save, `${jsonText(saved)}\n`);
  const token = await authoriseClear(store, save);
  if (!(await confirm(before))) return { before, cleared: false, after: null };
  await sendClear(elm, token);
  return { before, cleared: true, after: await readSnapshot(elm, { full: false }) };
}

/** Prints the codes in a snapshot, one line per kind and unit. */
export function printSnapshot(snapshot: ObdSnapshot, out: LineSink): void {
  const kinds: readonly (readonly [string, ReadonlyMap<string, readonly string[]>])[] = [
    ["stored", snapshot.stored],
    ["pending", snapshot.pending],
    ["permanent", snapshot.permanent],
  ];
  for (const [label, found] of kinds) {
    for (const [sender, list] of found) {
      out(`${label} codes from ${sender}: ${list.join(", ") || "none"}`);
    }
  }
  for (const [sender, state] of snapshot.readiness) {
    const lamp = state.lampOn ? "on" : "off";
    out(`unit ${sender}: warning lamp ${lamp}, ${String(state.codeCount)} stored codes`);
  }
  for (const note of snapshot.notes) out(`note: ${note}`);
}

/** What {@link clearCodesCommand} needs. */
export interface ClearCodesCommandParams {
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
  readonly store: WritableSnapshotStore;
  /** The CAN identifier width, 11 or 29 bits. */
  readonly idBits: 11 | 29;
  /** The CAN bit rate in bit/s. */
  readonly bitrate: number;
  /** The name of the new snapshot the codes are saved to. */
  readonly save: string;
  /** Do not ask before clearing. */
  readonly yes: boolean;
  readonly out: LineSink;
  /** Shows a prompt and returns what the user typed. */
  readonly ask: (prompt: string) => Promise<string>;
}

/**
 * The clear-codes command: select the bus, snapshot, confirm, clear and read again.
 *
 * @returns 0 when the codes were cleared, 1 when the user declined.
 * @throws ClearRefused, having sent nothing that changes the car, when the snapshot file exists or
 * the codes cannot be read.
 */
export async function clearCodesCommand(params: ClearCodesCommandParams): Promise<number> {
  const { elm, adapter, store, idBits, bitrate, save, yes, out, ask } = params;
  await elm.selectCan(idBits, bitrate);
  await elm.addressFunctional(FUNCTIONAL_ID[idBits]);
  const confirm = async (before: ObdSnapshot): Promise<boolean> => {
    out(`VIN: ${before.vin === null || before.vin === "" ? "not reported" : before.vin}`);
    printSnapshot(before, out);
    if (before.freezeFrames.size > 0) {
      out("freeze frames and misfire counts are saved with the snapshot");
    }
    out(`snapshot saved to ${save}`);
    out(
      "Mode 04 erases the stored codes, freeze frame and misfire data of every " +
        "emissions-related unit on the car, not one unit, and resets the readiness monitors.",
    );
    if (yes) return true;
    return (await ask("Erase them? Type yes to continue: ")) === "yes";
  };
  const outcome = await clearCodes({ elm, adapter, store, save, confirm });
  if (!outcome.cleared || outcome.after === null) {
    out("nothing cleared");
    return 1;
  }
  out("cleared; the readiness monitors are reset and will need a drive cycle to complete");
  out("reading the codes again:");
  printSnapshot(outcome.after, out);
  return 0;
}
