import { builtinProfiles } from "obd-read/profiles";
import { ProfileError, parseProfileText, type Profile } from "obd-read";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** The outcome of importing a profile file. */
export type ImportResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/** What the screens see of the available profiles. */
export interface ProfilesContextValue {
  /** Names of the profiles shipped in the bundle, sorted. */
  readonly builtin: readonly string[];
  /** Profiles imported from files this session, by name. */
  readonly imported: ReadonlyMap<string, Profile>;
  /** Every selectable name: shipped, then imported. */
  readonly names: readonly string[];
  /**
   * Validates a profile file's text with the same schema the shipped profiles pass, and adds it
   * on success. `fileName` names the source in any problem. Never throws for a bad file.
   */
  readonly importText: (text: string, fileName: string) => ImportResult;
}

const ProfilesContext = createContext<ProfilesContextValue | undefined>(undefined);

/** Holds the shipped and imported profiles. Imported ones last until the page closes. */
export function ProfilesProvider({ children }: { readonly children: ReactNode }) {
  const [imported, setImported] = useState<ReadonlyMap<string, Profile>>(new Map());
  const builtin = useMemo(() => builtinProfiles(), []);

  const importText = useCallback((text: string, fileName: string): ImportResult => {
    try {
      const profile = parseProfileText(text, fileName);
      setImported((previous) => new Map(previous).set(profile.name, profile));
      return { ok: true, name: profile.name };
    } catch (error) {
      if (error instanceof ProfileError) return { ok: false, problems: error.problems };
      throw error;
    }
  }, []);

  const value = useMemo(
    () => ({
      builtin,
      imported,
      names: [...builtin, ...[...imported.keys()].filter((name) => !builtin.includes(name))],
      importText,
    }),
    [builtin, imported, importText],
  );
  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

/** The available profiles. Throws outside a {@link ProfilesProvider}. */
export function useProfiles(): ProfilesContextValue {
  const value = useContext(ProfilesContext);
  if (value === undefined) throw new Error("useProfiles needs a ProfilesProvider");
  return value;
}
