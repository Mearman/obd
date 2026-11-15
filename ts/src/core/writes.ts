/**
 * Coding and adaptation writes, and putting a saved value back.
 *
 * The tool carries no vendor requests: the user supplies the exact write request and the read
 * request for the same identifier. The order is fixed and stops at the first step that fails: read
 * the current value, save it with the request to a new snapshot, show both, ask for a typed `yes`,
 * send the write once through the guard's write token, then read the value back.
 */

import { bytesEqual, concatBytes, fromHex, toUpperHex, byteAt, hexNumber } from "./bytes.js";
import { NegativeResponse, type UnitSession } from "./diag.js";
import { ElmError, type AdapterInfo, type Elm } from "./elm.js";
import {
  GuardError,
  READ_SERVICE,
  WRITE_SERVICE,
  authoriseWrite,
  identifier,
  type DiagProtocol,
  type SnapshotStore,
} from "./guard.js";
import {
  makeClient,
  unitSession,
  type LineSink,
  type UnitAddress,
  type UnitProfile,
} from "./unit-access.js";

/** Marks a snapshot as one this module wrote, so restore refuses any other kind of file. */
export const SNAPSHOT_KIND = "write";

/**
 * A {@link SnapshotStore} that can also create a snapshot. A platform supplies it (an exclusive
 * file create on Node, browser storage in a page).
 */
export interface WritableSnapshotStore extends SnapshotStore {
  /** Creates the snapshot. Rejects, leaving the existing contents, when one is already there. */
  create(snapshot: string, text: string): Promise<void>;
}

/** The write or restore command stopped before sending anything that changes the car. */
export class WriteRefused extends Error {
  override name = "WriteRefused";
}

/** One write request and the read request that reads the same identifier. */
export interface WritePlan {
  readonly protocol: DiagProtocol;
  readonly write: Uint8Array;
  readonly read: Uint8Array;
  /** The identifier bytes the write names. */
  readonly identifier: Uint8Array;
  /** The bytes the write sets, after its service byte and identifier. */
  readonly value: Uint8Array;
}

/**
 * Checks that `write` is the protocol's write service with a value and `read` reads exactly the
 * same identifier.
 *
 * @throws GuardError otherwise, before anything is sent.
 */
export function planWrite(protocol: DiagProtocol, write: Uint8Array, read: Uint8Array): WritePlan {
  const service = WRITE_SERVICE.get(protocol);
  if (service === undefined || write[0] !== service) {
    throw new GuardError(
      `${write.length === 0 ? "an empty request" : toUpperHex(write)} is not a ${protocol} write request`,
    );
  }
  const named = identifier(protocol, write);
  const value = write.slice(1 + named.length);
  if (value.length === 0) {
    throw new GuardError(`write ${toUpperHex(write)} carries no value to write`);
  }
  const readService = READ_SERVICE.get(protocol);
  if (readService === undefined) throw new GuardError(`${protocol} has no read service`);
  const expected = concatBytes(Uint8Array.of(readService), named);
  if (!bytesEqual(read, expected)) {
    throw new GuardError(
      `the read request must be ${toUpperHex(expected)}, which reads the identifier the write ` +
        `names; got ${read.length === 0 ? "an empty request" : toUpperHex(read)}`,
    );
  }
  return { protocol, write, read, identifier: named, value };
}

/** The result of one write or restore command. */
export interface WriteOutcome {
  readonly previous: Uint8Array;
  readonly written: boolean;
  /** The unit's reply to the write, when it was sent. */
  readonly reply?: Uint8Array;
  /** The value read back after the write, when that read succeeded. */
  readonly after?: Uint8Array;
  /** Why the read back failed, when it did. */
  readonly readBackError?: string;
}

/**
 * Sends the plan's read request and returns the value after the identifier in the reply.
 *
 * @throws ElmError when the reply names another identifier, and what `UnitSession.request` throws.
 */
export async function readValue(session: UnitSession, plan: WritePlan): Promise<Uint8Array> {
  const reply = await session.request(plan.read);
  const named = reply.slice(1, 1 + plan.identifier.length);
  if (!bytesEqual(named, plan.identifier)) {
    throw new ElmError(
      `reply ${toUpperHex(reply)} names identifier ${toUpperHex(named)}, ` +
        `not ${toUpperHex(plan.identifier)}`,
    );
  }
  return reply.slice(1 + plan.identifier.length);
}

/** What {@link writeValue} needs. */
export interface WriteValueParams {
  readonly elm: Elm;
  readonly profile: UnitProfile;
  readonly adapter: AdapterInfo;
  readonly unit: UnitAddress;
  readonly plan: WritePlan;
  readonly store: WritableSnapshotStore;
  /** The name of the new snapshot the current value is saved to. */
  readonly save: string;
  /** Asked with the current value; returns whether to go ahead. */
  readonly confirm: (previous: Uint8Array) => Promise<boolean>;
  /** The snapshot this write puts back, recorded in the new one. */
  readonly restores?: string;
}

function unitRecord(unit: UnitAddress): Record<string, string> {
  return {
    name: unit.name,
    request_id: hexNumber(unit.requestId, 1),
    response_id: hexNumber(unit.responseId, 1),
  };
}

/**
 * Saves the value the plan replaces, asks `confirm` with it, writes once, then reads the value back.
 *
 * @throws WriteRefused, having sent nothing that changes the car, when `save` already exists or the
 * session or the current value cannot be read. When `confirm` returns false the snapshot stays and
 * nothing is written.
 * @throws NegativeResponse when the unit refuses the write. A read back that fails after the write
 * is reported in the outcome, not thrown.
 */
export async function writeValue(params: WriteValueParams): Promise<WriteOutcome> {
  const { elm, profile, adapter, unit, plan, store, save, confirm, restores } = params;
  if (await store.exists(save)) {
    throw new WriteRefused(`${save} already exists; choose a new file for the snapshot`);
  }
  await elm.addressUnit(unit.requestId, unit.responseId);
  const session = unitSession(elm, profile, unit);
  let previous: Uint8Array;
  try {
    await makeClient(elm, profile, unit).start();
    previous = await readValue(session, plan);
  } catch (error) {
    if (!(error instanceof NegativeResponse || error instanceof ElmError)) throw error;
    throw new WriteRefused(
      `could not read the current value from ${unit.name} (${error.message}); nothing written`,
      { cause: error },
    );
  }
  const saved = {
    tool: "obd-read",
    kind: SNAPSHOT_KIND,
    taken: `${new Date().toISOString().slice(0, 19)}+00:00`,
    profile: { name: profile.name, status: profile.status },
    protocol: plan.protocol,
    unit: unitRecord(unit),
    read_request: toUpperHex(plan.read),
    write_request: toUpperHex(plan.write),
    previous_value: toUpperHex(previous),
    restores: restores ?? null,
    adapter: {
      identity: adapter.identity,
      description: adapter.description,
      stn_identity: adapter.stnIdentity,
      voltage: adapter.voltage,
    },
    transcript: [...elm.transcript.entries],
  };
  await store.create(save, `${JSON.stringify(saved, null, 2)}\n`);
  const token = await authoriseWrite(store, save, plan.protocol, plan.write);
  if (!(await confirm(previous))) return { previous, written: false };
  const reply = await session.request(plan.write, token);
  try {
    return { previous, written: true, reply, after: await readValue(session, plan) };
  } catch (error) {
    if (!(error instanceof NegativeResponse || error instanceof ElmError)) throw error;
    return { previous, written: true, reply, readBackError: error.message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRecord(recorded: unknown, expected: Record<string, string>): boolean {
  if (!isRecord(recorded)) return false;
  const keys = Object.keys(expected);
  return (
    Object.keys(recorded).length === keys.length && keys.every((k) => recorded[k] === expected[k])
  );
}

/**
 * The write that puts back the previous value a write snapshot recorded for `unit`.
 *
 * @throws WriteRefused when the snapshot is unreadable, is not a write snapshot, or was taken from
 * another unit, address pair or protocol.
 */
export async function planRestore(
  store: SnapshotStore,
  snapshot: string,
  profile: UnitProfile,
  unit: UnitAddress,
): Promise<WritePlan> {
  let saved: unknown;
  try {
    saved = JSON.parse(await store.readText(snapshot));
  } catch (error) {
    throw new WriteRefused(
      `cannot read the snapshot ${snapshot}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(saved) || saved.kind !== SNAPSHOT_KIND) {
    throw new WriteRefused(`${snapshot} is not a write snapshot`);
  }
  const recorded = saved.unit;
  const expected = unitRecord(unit);
  if (!sameRecord(recorded, expected)) {
    throw new WriteRefused(
      `${snapshot} was taken from ${JSON.stringify(recorded)}, not ${JSON.stringify(expected)}`,
    );
  }
  if (saved.protocol !== profile.protocol) {
    throw new WriteRefused(
      `${snapshot} was taken over ${String(saved.protocol)}, not ${profile.protocol}`,
    );
  }
  const names = ["read_request", "write_request", "previous_value"] as const;
  const missing = names.filter((name) => typeof saved[name] !== "string");
  if (missing.length > 0) throw new WriteRefused(`${snapshot} lacks ${missing.join(", ")}`);
  const text = (name: (typeof names)[number]): string => {
    const value = saved[name];
    return typeof value === "string" ? value : "";
  };
  let write: Uint8Array;
  let previous: Uint8Array;
  let read: Uint8Array;
  try {
    write = fromHex(text("write_request"));
    previous = fromHex(text("previous_value"));
    read = fromHex(text("read_request"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WriteRefused(`${snapshot} holds a value that is not hexadecimal`, { cause: error });
  }
  if (write.length === 0) throw new WriteRefused(`${snapshot} records an empty write request`);
  const original = planWrite(profile.protocol, write, read);
  return planWrite(
    profile.protocol,
    concatBytes(Uint8Array.of(byteAt(write, 0)), original.identifier, previous),
    original.read,
  );
}

/** A write to plan, or the snapshot of an earlier write to put back. */
export type WriteCommand =
  | { readonly command: "write"; readonly request: Uint8Array; readonly read: Uint8Array }
  | { readonly command: "restore"; readonly snapshot: string };

/** What {@link writeCommand} needs beside the command itself. */
export interface WriteCommandParams {
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
  readonly profile: UnitProfile;
  readonly unit: UnitAddress;
  readonly store: WritableSnapshotStore;
  /** The name of the new snapshot the current value is saved to. */
  readonly save: string;
  readonly out: LineSink;
  /** Shows a prompt and returns what the user typed. There is no way to skip it. */
  readonly ask: (prompt: string) => Promise<string>;
}

/**
 * The write and restore commands: plan, snapshot, confirm, write once, read back.
 *
 * @returns 0 when the value read back matches the request, 1 for anything else that did not throw.
 * @throws GuardError when the request is not an allowed write, WriteRefused when nothing was sent,
 * NegativeResponse when the unit refuses the write.
 */
export async function writeCommand(
  command: WriteCommand,
  params: WriteCommandParams,
): Promise<number> {
  const { elm, adapter, profile, unit, store, save, out, ask } = params;
  const restores = command.command === "restore" ? command.snapshot : undefined;
  const plan =
    command.command === "restore"
      ? await planRestore(store, command.snapshot, profile, unit)
      : planWrite(profile.protocol, command.request, command.read);
  const confirm = async (previous: Uint8Array): Promise<boolean> => {
    out(`unit: ${unit.name} (${hexNumber(unit.requestId, 1)} -> ${hexNumber(unit.responseId, 1)})`);
    out(`read request: ${toUpperHex(plan.read)}`);
    out(`current value: ${previous.length === 0 ? "(empty)" : toUpperHex(previous)}`);
    out(`write request: ${toUpperHex(plan.write)}`);
    out(`new value: ${toUpperHex(plan.value)}`);
    if (restores !== undefined) out(`this puts back the value saved in ${restores}`);
    out(`current value saved to ${save}`);
    return (
      (await ask(`Write ${toUpperHex(plan.write)} to ${unit.name}? Type yes to continue: `)) ===
      "yes"
    );
  };
  const outcome = await writeValue({
    elm,
    profile,
    adapter,
    unit,
    plan,
    store,
    save,
    confirm,
    ...(restores === undefined ? {} : { restores }),
  });
  if (!outcome.written || outcome.reply === undefined) {
    out("nothing written");
    return 1;
  }
  out(`sent ${toUpperHex(plan.write)}; reply ${toUpperHex(outcome.reply)}`);
  if (outcome.after === undefined) {
    out(`the value could not be read back: ${outcome.readBackError ?? ""}`);
    return 1;
  }
  out(`read back: ${outcome.after.length === 0 ? "(empty)" : toUpperHex(outcome.after)}`);
  if (bytesEqual(outcome.after, plan.value)) {
    out("the value now matches the request");
    return 0;
  }
  out(`the value does not match the request; restore with --snapshot ${save}`);
  return 1;
}
