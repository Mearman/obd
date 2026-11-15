/** Which errors a command reports as `error: ...` with exit status 1, and which are bugs. */

import { ActuationError } from "./actuate.js";
import { NegativeResponse } from "./diag.js";
import { ElmError } from "./elm.js";
import { GuardError } from "./guard.js";
import { OptionError } from "./options.js";
import { ClearRefused } from "./operations.js";
import { ProfileError } from "./profile.js";
import { TransportError } from "./transport.js";
import type { LineSink } from "./unit-access.js";
import { WriteRefused } from "./writes.js";

/**
 * Whether `error` is one a command reports to the user: the guard refusing a request, a bad
 * profile, option or transport, an adapter or unit error, or a command that stopped before it sent
 * anything that changes the car.
 */
export function isCommandError(error: unknown): error is Error {
  return (
    error instanceof GuardError ||
    error instanceof ProfileError ||
    error instanceof TransportError ||
    error instanceof ElmError ||
    error instanceof NegativeResponse ||
    error instanceof ClearRefused ||
    error instanceof WriteRefused ||
    error instanceof ActuationError ||
    error instanceof OptionError
  );
}

/**
 * Prints `error: <message>` for a command error and returns the exit status 1.
 *
 * @throws The error itself when it is not a {@link isCommandError}, so a bug is never reported as
 * a refusal.
 */
export function reportCommandError(error: unknown, out: LineSink): number {
  if (!isCommandError(error)) throw error;
  out(`error: ${error.message}`);
  return 1;
}
