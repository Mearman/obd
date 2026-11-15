import { ORPCError } from "@orpc/client";
import { builtinProfiles } from "obd-read/profiles";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useDatabase } from "../database/DatabaseProvider";
import type { DiagnosticsClient } from "../diagnostics/client";

/** The outcome of importing a profile file. */
export type ImportResult =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/** What the screens see of the available profiles. */
export interface ProfilesContextValue {
  /** Names of the profiles shipped in the bundle, sorted. */
  readonly builtin: readonly string[];
  /** Names of the profiles imported from files, kept in the service's storage across reloads. */
  readonly imported: readonly string[];
  /** Every selectable name: shipped, then imported. */
  readonly names: readonly string[];
  /**
   * Has the service validate a profile file's text against the same schema the shipped profiles pass, and keep it on success. Never throws for a bad file.
   */
  readonly importText: (text: string) => Promise<ImportResult>;
}

const ProfilesContext = createContext<ProfilesContextValue | undefined>(undefined);

/** Holds the shipped profiles and the ones the service has stored. */
export function ProfilesProvider({
  client,
  children,
}: {
  readonly client: DiagnosticsClient;
  readonly children: ReactNode;
}) {
  const [imported, setImported] = useState<readonly string[]>([]);
  const builtin = useMemo(() => builtinProfiles(), []);
  // Changes when any tab writes, so a profile imported in another tab appears here.
  const { revision } = useDatabase();

  useEffect(() => {
    let current = true;
    void client.profiles.list().then((names) => {
      if (current) setImported(names);
    });
    return () => {
      current = false;
    };
  }, [client, revision]);

  const importText = useCallback(
    async (text: string): Promise<ImportResult> => {
      try {
        const { name } = await client.profiles.import({ json: text });
        setImported(await client.profiles.list());
        return { ok: true, name };
      } catch (error) {
        if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
          return { ok: false, problems: error.message.split("; ") };
        }
        throw error;
      }
    },
    [client],
  );

  const value = useMemo(
    () => ({
      builtin,
      imported,
      names: [...builtin, ...imported.filter((name) => !builtin.includes(name))],
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
