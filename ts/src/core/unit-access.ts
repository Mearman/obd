/**
 * The smallest description of a profile and a unit that the write and actuator commands need, and
 * the guarded session and protocol client built from it. The profile module owns the full types;
 * these structural types are satisfied by them, so nothing here changes when they land.
 */

import { UnitSession } from "./diag.js";
import type { Elm } from "./elm.js";
import { Kwp2000 } from "./kwp2000.js";
import { DiagProtocol } from "./guard.js";
import { Uds } from "./uds.js";

/** Receives one line of output for the user. */
export type LineSink = (line: string) => void;

/** The parts of a diagnostic profile the write and actuator commands read. */
export interface UnitProfile {
  readonly name: string;
  /** How far the profile's identifiers are confirmed, recorded in every snapshot. */
  readonly status: string;
  readonly protocol: DiagProtocol;
  /** The diagnostic session sub-function the profile names for this protocol. */
  readonly session: number;
}

/** The CAN address pair and name of one control unit. */
export interface UnitAddress {
  readonly name: string;
  readonly requestId: number;
  readonly responseId: number;
}

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
