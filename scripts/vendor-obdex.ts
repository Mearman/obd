/**
 * Rebuilds `src/data/obdex-generic.json` from a downloaded OBDex `generic.min.json`.
 *
 * Usage: node scripts/vendor-obdex.ts generic.min.json <commit> <retrieved-date> > src/data/obdex-generic.json
 *
 * Only the English title of each code is kept, with the spaced dashes some titles use written as a plain hyphen. The bundle is published at https://foerbsnavi.github.io/OBDex/generic.min.json and the data is CC0 1.0.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const bundleSchema = z.array(z.object({ code: z.string(), title: z.object({ en: z.string() }) }));

/** The vendored JSON document for a bundle's text, with its codes in sorted order. */
export function renderGenericTitles(bundleText: string, commit: string, retrieved: string): string {
  const titles = new Map<string, string>();
  for (const { code, title } of bundleSchema.parse(JSON.parse(bundleText))) {
    titles.set(code, title.en.replaceAll(" — ", " - ").replaceAll(" – ", " - "));
  }
  const notes = [
    "Generic OBD-II fault-code titles (English), from OBDex: https://github.com/foerbsnavi/OBDex",
    "Licence of the data: CC0 1.0 (LICENSE-DATA in that repository).",
    `Source: https://foerbsnavi.github.io/OBDex/generic.min.json retrieved ${retrieved}; repository head then ${commit}.`,
    "Rebuild with scripts/vendor-obdex.ts.",
  ].join("\n");
  const sorted = Object.fromEntries([...titles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ notes, titles: sorted }, null, 2)}\n`;
}

const [bundle, commit, retrieved] = process.argv.slice(2);
if (process.argv[1] === import.meta.filename) {
  if (bundle === undefined || commit === undefined || retrieved === undefined) {
    throw new Error(
      "usage: node scripts/vendor-obdex.ts generic.min.json <commit> <retrieved-date>",
    );
  }
  process.stdout.write(renderGenericTitles(readFileSync(bundle, "utf8"), commit, retrieved));
}
