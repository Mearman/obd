/** The colour scheme choices: follow the system, or force one. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

/** A colour scheme choice. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Narrows an unknown value (a stored string, a select's value) to a {@link ThemePreference}. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

const STORAGE_KEY = "obd-read.theme";

/**
 * Reads the stored choice. Browser storage can be absent or throw (private windows, blocked site
 * data), so any failure reads as "follow the system".
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Stores the choice for later visits; a storage failure only loses the convenience. */
export function storeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage is a per-viewer convenience, so the page works without it.
  }
}

/**
 * Applies the choice to the document: "system" removes `data-theme` so the media query decides,
 * and "light" or "dark" force that scheme.
 */
export function applyThemePreference(preference: ThemePreference, root: HTMLElement): void {
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
}
