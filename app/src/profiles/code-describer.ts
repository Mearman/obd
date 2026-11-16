import {
  CodeNames,
  describerOf,
  parseProfileCodes,
  type CodeDescriber,
  type CodeTable,
  type Storage,
} from "obd-read";
import { builtinProfileData, builtinProfiles } from "obd-read/profiles";
import { useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";

/**
 * The code tables of the profile named `profile`, found the way the service finds a profile: an imported one first, then a shipped one. A profile this app has neither shipped nor imported (a report saved on another device, or before its profile was removed) has none, so its codes go undescribed.
 *
 * @param storage The database, for imported profiles; `undefined` when it cannot be opened, which leaves only the shipped profiles.
 */
async function profileCodes(
  profile: string,
  storage: Storage | undefined,
): Promise<ReadonlyMap<string, CodeTable>> {
  const imported = await storage?.getProfile(profile);
  if (imported !== undefined) return parseProfileCodes(imported.document, profile);
  if (builtinProfiles().includes(profile)) {
    return parseProfileCodes(builtinProfileData(profile), profile);
  }
  return new Map();
}

/**
 * The describer the command line writes fault code tables with ({@link describerOf}), for a table of codes read under `profile` (`null` for none): a generic OBD-II read's codes (`generic`) from the bundled generic titles, a unit's codes from the profile's code tables. The generic titles are loaded on first use, as a chunk of their own.
 *
 * @returns `undefined` until the titles and the profile's tables are loaded; a profile's tables wait for the database to open or prove unavailable, since the profile may be an imported one.
 */
export function useCodeDescriber(
  profile: string | null,
  generic: boolean,
): CodeDescriber | undefined {
  const { state } = useDatabase();
  const [describer, setDescriber] = useState<
    { readonly key: string; readonly describe: CodeDescriber } | undefined
  >(undefined);
  // A profile's tables may be in the database, so they wait for it to open; no profile needs nothing from it.
  const waiting = profile !== null && state.status === "opening";
  const storage = state.status === "ready" ? state.storage : undefined;
  const key = `${profile ?? ""}\n${String(generic)}\n${waiting ? "waiting" : state.status}`;

  useEffect(() => {
    if (waiting) return;
    let current = true;
    const tables =
      profile === null
        ? Promise.resolve(new Map<string, CodeTable>())
        : profileCodes(profile, storage);
    void Promise.all([import("obd-read/data"), tables]).then(([{ loadGenericTitles }, codes]) => {
      if (!current) return;
      const names = new CodeNames(loadGenericTitles(), codes, []);
      setDescriber({ key, describe: describerOf(names, generic) });
    });
    return () => {
      current = false;
    };
  }, [key, waiting, profile, generic, storage]);

  return describer?.key === key ? describer.describe : undefined;
}
