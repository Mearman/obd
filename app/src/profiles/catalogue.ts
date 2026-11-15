import { loadBuiltinProfile } from "obd-read/profiles";

/** What the picker shows for one selectable profile. */
export interface CatalogueEntry {
  /** The name a connection and a stored run carry. */
  readonly name: string;
  /** The make or family the entry is grouped under. */
  readonly group: string;
  /** The vehicles it covers, in words. */
  readonly title: string;
  /** What it adds beyond the title: the protocol and bus. */
  readonly detail: string;
  readonly units: number;
  readonly status: string;
  readonly imported: boolean;
}

/** The group for profiles that came from a file and are not in the bundle. */
export const IMPORTED_GROUP = "Imported";

const GROUP_BY_PREFIX: ReadonlyMap<string, string> = new Map([
  ["bmw", "BMW"],
  ["ford", "Ford"],
  ["honda", "Honda and Acura"],
  ["hyundai", "Hyundai, Kia and Genesis"],
  ["mazda", "Mazda"],
  ["mercedes", "Mercedes-Benz"],
  ["mitsubishi", "Mitsubishi"],
  ["nissan", "Nissan and Infiniti"],
  ["psa", "Peugeot, Citroen, DS and Opel"],
  ["renault", "Renault and Dacia"],
  ["toyota", "Toyota and Lexus"],
  ["vag", "Volkswagen Group"],
  ["vw", "Volkswagen Group"],
]);

/** The group a shipped profile belongs to, from the make its name starts with. */
export function groupOf(name: string): string {
  const prefix = name.split("-")[0] ?? name;
  return GROUP_BY_PREFIX.get(prefix) ?? "Other";
}

/** Splits a description at its first comma into the vehicles and the technical remainder. */
export function splitDescription(description: string): { title: string; detail: string } {
  const comma = description.indexOf(",");
  if (comma < 0) return { title: description, detail: "" };
  return { title: description.slice(0, comma), detail: description.slice(comma + 1).trim() };
}

/** The entry for a shipped profile. */
export function shippedEntry(name: string): CatalogueEntry {
  const profile = loadBuiltinProfile(name);
  const { title, detail } = splitDescription(profile.description);
  return {
    name,
    group: groupOf(name),
    title,
    detail,
    units: profile.units.size,
    status: profile.status,
    imported: false,
  };
}

/** The entry for an imported profile, of which only the name is known to the screen. */
export function importedEntry(name: string): CatalogueEntry {
  return { name, group: IMPORTED_GROUP, title: name, detail: "", units: 0, status: "", imported: true };
}

/** Whether `entry` matches every word of `query`, ignoring case, in its name, title, detail or group. */
export function matches(entry: CatalogueEntry, query: string): boolean {
  const haystack = `${entry.name} ${entry.title} ${entry.detail} ${entry.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

/** Groups entries by their group, groups and entries sorted, with the imported group last. */
export function grouped(
  entries: readonly CatalogueEntry[],
): readonly { readonly group: string; readonly entries: readonly CatalogueEntry[] }[] {
  const byGroup = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry]);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) =>
      a === IMPORTED_GROUP ? 1 : b === IMPORTED_GROUP ? -1 : a.localeCompare(b, "en-GB"),
    )
    .map(([group, list]) => ({
      group,
      entries: [...list].sort((a, b) => a.title.localeCompare(b.title, "en-GB")),
    }));
}
