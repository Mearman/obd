/**
 * Which profiles a VIN suggests, from each profile's {@link VinHint}. Platform-free: it takes profiles already loaded.
 */

import type { Profile } from "./profile.js";

/** How well a VIN fits a profile: `model` when its descriptor starts with one of the profile's models, `maker` when the profile names no models and only the WMI was compared. */
export type VinMatch = "model" | "maker";

/** A profile a VIN suggests and how well it fits. */
export interface ProfileSuggestion {
  readonly profile: Profile;
  readonly match: VinMatch;
}

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * How well `vin` fits `profile`, or `undefined` when it does not: the VIN is not seventeen VIN characters, the profile has no hint, the WMI is not one the profile lists, or the profile lists models and the descriptor (characters 4 onwards) starts with none of them. Case and surrounding space are ignored.
 */
export function vinMatch(profile: Pick<Profile, "vin">, vin: string): VinMatch | undefined {
  const read = vin.trim().toUpperCase();
  const hint = profile.vin;
  if (!VIN.test(read) || hint === undefined || !hint.wmi.includes(read.slice(0, 3))) {
    return undefined;
  }
  if (hint.models.length === 0) return "maker";
  const descriptor = read.slice(3);
  return hint.models.some((model) => descriptor.startsWith(model)) ? "model" : undefined;
}

/** The profiles `vin` fits, model matches first, then maker matches, each group by name. */
export function profilesForVin(vin: string, profiles: readonly Profile[]): ProfileSuggestion[] {
  const rank: Record<VinMatch, number> = { model: 0, maker: 1 };
  return profiles
    .flatMap((profile) => {
      const match = vinMatch(profile, vin);
      return match === undefined ? [] : [{ profile, match }];
    })
    .sort(
      (a, b) => rank[a.match] - rank[b.match] || a.profile.name.localeCompare(b.profile.name, "en"),
    );
}
