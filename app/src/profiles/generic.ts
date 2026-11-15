import { GENERIC_PROFILE } from "obd-read";

/** What the generic choice is called wherever a profile is named. */
export const GENERIC_TITLE = "Generic OBD-II (no profile)";

/** What a generic connection can and cannot do, in one line. */
export const GENERIC_SUMMARY =
  "Reads the legislated OBD-II services any compliant car answers (VIN, stored, pending and permanent codes, readiness, freeze frame, live values) and can clear emissions codes after saving a snapshot. It cannot address one control unit: probing, identification, per-unit codes, writes and actuator tests need a profile.";

/** Why a unit-level action is disabled on a generic connection. */
export const PROFILE_REQUIRED_REASON =
  "This addresses one control unit, so it needs a vehicle profile. Disconnect and choose a profile on Connect to use it.";

/** The text for a profile name as stored on a run or report, or for a connection's profile (`null` when generic). */
export function profileTitle(name: string | null): string {
  return name === null || name === GENERIC_PROFILE ? GENERIC_TITLE : name;
}
