import {
  parseProfile,
  profilesForVin,
  type Profile,
  type ProfileSuggestion,
  type Storage,
} from "obd-read";
import { builtinProfiles, loadBuiltinProfile } from "obd-read/profiles";
import { useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";

/** Every profile a connection can name, as the service finds them: an imported profile in place of a shipped one of the same name. */
export async function availableProfiles(storage: Storage | undefined): Promise<Profile[]> {
  const imported = storage === undefined ? [] : await storage.listProfiles();
  const names = new Set(imported.map((stored) => stored.name));
  return [
    ...imported.map((stored) => parseProfile(stored.document, stored.name)),
    ...builtinProfiles()
      .filter((name) => !names.has(name))
      .map(loadBuiltinProfile),
  ];
}

/**
 * The shipped and imported profiles `vin` suggests ({@link profilesForVin}), or none while `vin` is undefined or the database is still opening, since an imported profile may match.
 */
export function useProfileSuggestions(vin: string | undefined): readonly ProfileSuggestion[] {
  const { state, revision } = useDatabase();
  const waiting = state.status === "opening";
  const storage = state.status === "ready" ? state.storage : undefined;
  const [found, setFound] = useState<
    { readonly vin: string; readonly suggestions: readonly ProfileSuggestion[] } | undefined
  >(undefined);

  useEffect(() => {
    if (vin === undefined || waiting) return;
    let current = true;
    void availableProfiles(storage).then((profiles) => {
      if (current) setFound({ vin, suggestions: profilesForVin(vin, profiles) });
    });
    return () => {
      current = false;
    };
  }, [vin, waiting, storage, revision]);

  return found !== undefined && found.vin === vin ? found.suggestions : [];
}
