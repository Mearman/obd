/** Per-browser memory of the Live screen's choices. Every access is guarded: storage can be absent, full or refused, and the screen works without it. */

const SELECTION_KEY = "obd.live.selection";
const PINS_KEY = "obd.live.pins";

function readNames(key: string): readonly string[] | undefined {
  try {
    const text = window.localStorage.getItem(key);
    if (text === null) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return undefined;
  }
}

function writeNames(key: string, names: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(names));
  } catch {
    // The choice only lasts for this visit.
  }
}

/** The value names chosen last time, or `undefined` when none are remembered. */
export const readSelection = (): readonly string[] | undefined => readNames(SELECTION_KEY);

/** Remembers the value names chosen. */
export const writeSelection = (names: readonly string[]): void => {
  writeNames(SELECTION_KEY, names);
};

/** The labels of the pinned values; none when none are remembered. */
export const readPins = (): readonly string[] => readNames(PINS_KEY) ?? [];

/** Remembers the labels of the pinned values. */
export const writePins = (labels: readonly string[]): void => {
  writeNames(PINS_KEY, labels);
};
