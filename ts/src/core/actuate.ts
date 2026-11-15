/**
 * Actuator tests: drive one input or output for a bounded time, then always hand control back.
 *
 * The tool carries no vendor requests: the user supplies the exact start request and the request
 * that returns control to the unit. Once the start request has been attempted, the stop request is
 * sent whatever happens next: a refused or failed start, a failed tester present, a timeout or a
 * thrown cancellation.
 */

import { toUpperHex, hexNumber } from "./bytes.js";
import type { UnitSession } from "./diag.js";
import type { Elm } from "./elm.js";
import {
  DiagProtocol,
  GuardError,
  authoriseActuation,
  checkActuation,
  type ActuationTokens,
} from "./guard.js";
import { sleep as realSleep } from "./time.js";
import {
  makeClient,
  unitSession,
  type LineSink,
  type UnitAddress,
  type UnitProfile,
} from "./unit-access.js";

/** Resolves after the given number of milliseconds; tests substitute their own. */
export type Sleep = (milliseconds: number) => Promise<void>;

/**
 * Tester present with a reply requested: KWP2000 responseRequired yes (ISO/DIS 14230-3 table
 * 6.4.2.1), and UDS sub-function 0 (python-udsoncan's TesterPresent service).
 */
export const TESTER_PRESENT: ReadonlyMap<DiagProtocol, Uint8Array> = new Map([
  [DiagProtocol.KWP2000, Uint8Array.of(0x3e, 0x01)],
  [DiagProtocol.UDS, Uint8Array.of(0x3e, 0x00)],
]);

/**
 * Milliseconds between tester present requests while a test holds control. ISO/DIS 14230-3 section
 * 6.4.3 says a unit that hears no request returns to normal operation, which ends the test early;
 * units time out after a few seconds of silence, so two seconds keeps the session open with margin.
 */
export const TESTER_PRESENT_MS = 2000;

/** The stop request that hands control back to the unit failed. */
export class ActuationError extends Error {
  override name = "ActuationError";
}

/**
 * Waits `milliseconds`, sending tester present every {@link TESTER_PRESENT_MS} so the session stays
 * open.
 *
 * @throws GuardError when the protocol has no tester present request, and what the session throws.
 */
export async function hold(
  session: UnitSession,
  milliseconds: number,
  sleep: Sleep,
): Promise<void> {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(TESTER_PRESENT_MS, remaining);
    await sleep(step);
    remaining -= step;
    if (remaining > 0) {
      const testerPresent = TESTER_PRESENT.get(session.protocol);
      if (testerPresent === undefined) {
        throw new GuardError(`${session.protocol} has no tester present request`);
      }
      await session.request(testerPresent);
    }
  }
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
}

/**
 * Sends the start request, holds for `milliseconds`, then sends the stop request, printing each and
 * its reply.
 *
 * The stop request is sent after any error once the start has been attempted, and that error is
 * thrown after it.
 *
 * @throws ActuationError when the stop request itself fails, naming any earlier error too.
 */
export async function actuate(
  session: UnitSession,
  tokens: ActuationTokens,
  milliseconds: number,
  out: LineSink,
  sleep: Sleep = realSleep,
): Promise<void> {
  const start = tokens.start.payload;
  const stop = tokens.stop.payload;
  let failure: { readonly error: unknown } | undefined;
  try {
    out(`sending start request ${toUpperHex(start)}`);
    out(`start reply: ${toUpperHex(await session.request(start, tokens.start))}`);
    out(`holding for ${String(milliseconds / 1000)} seconds`);
    await hold(session, milliseconds, sleep);
  } catch (error) {
    failure = { error };
  }
  // The stop request goes out after any error, and that error is thrown once it has.
  out(`sending stop request ${toUpperHex(stop)}`);
  let stopReply: Uint8Array;
  try {
    stopReply = await session.request(stop, tokens.stop);
  } catch (error) {
    const after = failure === undefined ? "" : ` after ${describeFailure(failure.error)}`;
    throw new ActuationError(
      `the stop request ${toUpperHex(stop)} failed (${describeFailure(error)})${after}; the ` +
        "unit may still be under test control, so switch the ignition off to end it",
      { cause: error },
    );
  }
  out(`stop reply: ${toUpperHex(stopReply)}`);
  if (failure !== undefined) throw failure.error;
}

/** What {@link actuateCommand} needs. */
export interface ActuateCommandParams {
  readonly elm: Elm;
  readonly profile: UnitProfile;
  readonly unit: UnitAddress;
  /** The start request. */
  readonly request: Uint8Array;
  /** The request that returns control to the unit. */
  readonly stop: Uint8Array;
  /** How long to hold control, in milliseconds. */
  readonly durationMs: number;
  readonly out: LineSink;
  /** Shows a prompt and returns what the user typed. There is no way to skip it. */
  readonly ask: (prompt: string) => Promise<string>;
  readonly sleep?: Sleep;
}

/**
 * The actuate command: check, open the session, confirm, then start, hold and always stop.
 *
 * @returns 0 when control was handed back, 1 when the user declined and nothing was sent.
 * @throws GuardError, before anything is sent, for a request or duration the guard refuses.
 * @throws ActuationError when the stop request fails, and what the start or hold throws once the
 * stop has been sent.
 */
export async function actuateCommand(params: ActuateCommandParams): Promise<number> {
  const { elm, profile, unit, request, stop, durationMs, out, ask } = params;
  checkActuation(profile.protocol, request, stop, durationMs);
  await elm.addressUnit(unit.requestId, unit.responseId);
  await makeClient(elm, profile, unit).start();
  const seconds = String(durationMs / 1000);
  out(`unit: ${unit.name} (${hexNumber(unit.requestId, 1)} -> ${hexNumber(unit.responseId, 1)})`);
  out(`start request: ${toUpperHex(request)}`);
  out(`stop request: ${toUpperHex(stop)}, sent after ${seconds} seconds or on any error`);
  const prompt =
    `Drive ${unit.name} with ${toUpperHex(request)} for ${seconds} seconds, then send ` +
    `${toUpperHex(stop)}? Type yes to continue: `;
  if ((await ask(prompt)) !== "yes") {
    out("nothing sent");
    return 1;
  }
  const tokens = authoriseActuation(profile.protocol, request, stop, durationMs);
  await actuate(unitSession(elm, profile, unit), tokens, durationMs, out, params.sleep);
  out("control handed back to the unit");
  return 0;
}
