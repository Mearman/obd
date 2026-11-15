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

/** The CAN address pair and name of one control unit. */
export type UnitAddress = Pick<Unit, "name" | "requestId" | "responseId">;

/** A guarded request channel to one unit. The unit must already be addressed. */
export function unitSession(elm: Elm, profile: UnitProfile, unit: UnitAddress): UnitSession {
  return new UnitSession(elm, profile.protocol, unit.responseId);
}

/** The protocol client the profile names, bound to one unit. */
export function makeClient(elm: Elm, profile: UnitProfile, unit: UnitAddress): Kwp2000 | Uds {
  const session = unitSession(elm, profile, unit);
  return profile.protocol === DiagProtocol.UDS
    ? new Uds(session, profile.session)
    : new Kwp2000(session, profile.session);
}
