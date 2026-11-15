/** The choices a run can be started with, as names of the legislated values (`runs.values`). */

/** A named set of values. */
export interface Preset {
  readonly label: string;
  /** The names of the supported values it selects. */
  readonly select: (supported: readonly string[]) => readonly string[];
}

const ENGINE = [
  "vehicle-speed",
  "engine-speed",
  "engine-load",
  "throttle-position",
  "coolant-temperature",
] as const;

/** Fuel trims, oxygen and lambda sensors and the fuel system status. */
const MIXTURE = /^(short-fuel-trim|long-fuel-trim|o2-sensor|lambda|fuel-system-status)/;

/** The presets the Live section offers. */
export const PRESETS: readonly Preset[] = [
  {
    label: "Engine",
    select: (supported) => supported.filter((name) => ENGINE.some((e) => e === name)),
  },
  {
    label: "Fuel and mixture",
    select: (supported) => supported.filter((name) => MIXTURE.test(name)),
  },
  { label: "Everything", select: (supported) => supported },
];

/** Whether two selections hold the same names, in any order. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/** The preset a selection equals among the supported values, if any. */
export function presetOf(
  selected: readonly string[],
  supported: readonly string[],
): Preset | undefined {
  return PRESETS.find((preset) => sameSelection(preset.select(supported), selected));
}

/**
 * The selection a run starts with: the names remembered from last time that this car supports, else the Engine preset, else everything the car supports.
 */
export function initialSelection(
  remembered: readonly string[] | undefined,
  supported: readonly string[],
): readonly string[] {
  const kept = (remembered ?? []).filter((name) => supported.includes(name));
  if (kept.length > 0) return kept;
  const engine = PRESETS[0]?.select(supported) ?? [];
  return engine.length > 0 ? engine : supported;
}
