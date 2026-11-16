import { z } from "zod";

/** The screens the app's navigation lists, in order. */
export const SCREEN_NAMES = ["session", "library", "guide", "settings"] as const;

/** One screen of the app. */
export type ScreenName = (typeof SCREEN_NAMES)[number];

/** The screen shown when the address names none, and left out of the address. */
export const DEFAULT_SCREEN: ScreenName = "session";

/**
 * What the address's query holds: the active screen and, on the Library, the item open as `<kind>:<id>`. A value that is not valid reads as absent, and any other parameter is kept as it is.
 */
export const searchSchema = z.looseObject({
  screen: z.enum(SCREEN_NAMES).optional().catch(undefined),
  item: z.string().optional().catch(undefined),
});

/** The validated query of the app's address. */
export type AppSearch = z.infer<typeof searchSchema>;
