/**
 * The guarded session and protocol client for one unit of a profile, and the parts of the profile
 * and unit the write and actuator commands read.
 */

import { UnitSession } from "./diag.js";
import type { Elm } from "./elm.js";
import { Kwp2000 } from "./kwp2000.js";
import { DiagProtocol } from "./guard.js";
import type { Profile, Unit } from "./profile.js";
import { Uds } from "./uds.js";

/** Receives one line of output for the user. */
export type LineSink = (line: string) => void;

/** The parts of a diagnostic profile the write and actuator commands read. */
export type UnitProfile = Pick<Profile, "name" | "status" | "protocol" | "session">;

/**
 * The CAN address pair, extended address and identifier width when it has them, and name of one control unit, with the diagnostics the unit carries when it overrides the profile's.
 */
export type UnitAddress = Pick<
  Unit,
  "name" | "requestId" | "responseId" | "extendedAddress" | "idBits"
> &
  Partial<Pick<Unit, "protocol" | "session">>;

/** The protocol and session a unit is read with: its own when it has them, else the profile's. */
export function unitDiagnostics(
  profile: UnitProfile,
  unit: UnitAddress,
): Pick<UnitProfile, "protocol" | "session"> {
  return { protocol: unit.protocol ?? profile.protocol, session: unit.session ?? profile.session };
}

/** A guarded request channel to one unit. The unit must already be addressed. */
export function unitSession(elm: Elm, profile: UnitProfile, unit: UnitAddress): UnitSession {
  return new UnitSession(elm, unitDiagnostics(profile, unit).protocol, unit.responseId);
}

/** The protocol client the unit's diagnostics name, bound to that unit. */
export function makeClient(elm: Elm, profile: UnitProfile, unit: UnitAddress): Kwp2000 | Uds {
  const session = unitSession(elm, profile, unit);
  const diagnostics = unitDiagnostics(profile, unit);
  return diagnostics.protocol === DiagProtocol.UDS
    ? new Uds(session, diagnostics.session)
    : new Kwp2000(session, diagnostics.session);
}
