/**
 * The generic OBD-II session: a connection with no vehicle profile.
 *
 * Such a session speaks only the legislated OBD-II services (SAE J1979) that every compliant car answers, on the CAN settings the `obd` command defaults to. It knows no control unit by name, so every operation that addresses one unit needs a profile and fails with {@link ProfileRequired}. This module is platform-free.
 */

import { ProfileError, canBus, type Profile } from "./profile.js";

/** The name stored runs, scan reports and snapshots carry when their session had no profile. No profile may use it. */
export const GENERIC_PROFILE = "generic-obd2";

/** The CAN settings of a generic session: the `obd` command's defaults. */
export const GENERIC_BUS = { idBits: 11, bitrate: 500_000 } as const;

/** The oRPC error code a {@link ProfileRequired} failure carries to a caller. */
export const PROFILE_REQUIRED_CODE = "PROFILE_REQUIRED";

/** An operation needs a vehicle profile and the session has none. */
export class ProfileRequired extends ProfileError {
  override name = "ProfileRequired";

  /** @param operation What was asked for, such as "reading one unit's fault codes". */
  constructor(operation: string) {
    super([
      `${operation} needs a vehicle profile, and this connection is generic OBD-II with none; connect with a profile to use it`,
    ]);
  }
}

/** The profile an operation needs, or a thrown {@link ProfileRequired} naming `operation`. */
export function requireProfile(profile: Profile | undefined, operation: string): Profile {
  if (profile === undefined) throw new ProfileRequired(operation);
  return profile;
}

/** The CAN settings a session reads the legislated services on: the profile's, or {@link GENERIC_BUS}. */
export function sessionBus(profile: Profile | undefined): {
  readonly idBits: 11 | 29;
  readonly bitrate: number;
} {
  return profile === undefined ? GENERIC_BUS : canBus(profile);
}

/** The name a session's stored records carry: its profile's, or {@link GENERIC_PROFILE}. */
export function profileLabel(profile: Profile | undefined): string {
  return profile === undefined ? GENERIC_PROFILE : profile.name;
}
