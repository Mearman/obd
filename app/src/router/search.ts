import { ORIGINS } from "obd-read";
import { z } from "zod";
import { LIBRARY_KINDS } from "../library/items";
import { GROUPINGS, SORT_VALUES } from "../library/view";

/** The screens the app's navigation lists, in order. */
export const SCREEN_NAMES = ["session", "library", "guide", "settings"] as const;

/** One screen of the app. */
export type ScreenName = (typeof SCREEN_NAMES)[number];

/** The screen shown when the address names none, and left out of the address. */
export const DEFAULT_SCREEN: ScreenName = "session";

/** A UTC day as `YYYY-MM-DD`. */
const day = z.iso.date().optional().catch(undefined);

/**
 * What the address's query holds: the active screen and, on the Library, the item open as `<kind>:<id>` and how the list is filtered (`kind`, `origin`, the search `q`, the days `from` and `to`), sorted (`sort`, a column with `-` before it for descending) and grouped (`group`). A value that is not valid reads as absent, and any other parameter is kept as it is.
 */
export const searchSchema = z.looseObject({
  screen: z.enum(SCREEN_NAMES).optional().catch(undefined),
  item: z.string().optional().catch(undefined),
  kind: z.enum(LIBRARY_KINDS).optional().catch(undefined),
  origin: z.enum(ORIGINS).optional().catch(undefined),
  // The router reads a value that parses as JSON as that value, so a search for digits arrives as a number.
  q: z
    .union([z.string(), z.number().transform(String)])
    .optional()
    .catch(undefined),
  from: day,
  to: day,
  sort: z.enum(SORT_VALUES).optional().catch(undefined),
  group: z.enum(GROUPINGS).optional().catch(undefined),
});

/** The validated query of the app's address. */
export type AppSearch = z.infer<typeof searchSchema>;
