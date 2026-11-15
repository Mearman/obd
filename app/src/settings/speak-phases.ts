import { useState } from "react";

const STORAGE_KEY = "obd-read.speak-phases";

/** Reads whether the Guide screen reads each new phase aloud. The default is off: only a stored "on" turns it on. Browser storage can be absent or throw (private windows, blocked site data), and then the default applies. */
export function readSpeakPhases(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Stores the choice for later visits in this browser; a storage failure only loses the convenience. */
function storeSpeakPhases(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage is a per-viewer convenience, so the page works without it.
  }
}

/** The setting "Read each phase aloud" and a function that changes and stores it. It lives in this browser only, never in the database. */
export function useSpeakPhases(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(readSpeakPhases);
  return [
    enabled,
    (next) => {
      setEnabled(next);
      storeSpeakPhases(next);
    },
  ];
}
