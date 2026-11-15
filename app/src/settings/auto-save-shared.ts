import { useState } from "react";

const STORAGE_KEY = "obd-read.auto-save-shared";

/**
 * Reads whether a received link is saved as soon as it has been decoded. The default is on: only a stored "off" turns it off. Browser storage can be absent or throw (private windows, blocked site data), and then the default applies.
 */
export function readAutoSaveShared(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Stores the choice for later visits in this browser; a storage failure only loses the convenience. */
export function storeAutoSaveShared(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage is a per-viewer convenience, so the page works without it.
  }
}

/** The setting "Save received links automatically" and a function that changes and stores it. It lives in this browser only, never in the database. */
export function useAutoSaveShared(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(readAutoSaveShared);
  return [
    enabled,
    (next) => {
      setEnabled(next);
      storeAutoSaveShared(next);
    },
  ];
}
