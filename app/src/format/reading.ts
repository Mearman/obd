/**
 * How a reading is shown, never how it is stored.
 *
 * A sample keeps the exact number the car's value decodes to (a throttle byte of 64 is 25.098039215686274 %); only the screens round it, and exports keep the exact number. The decimals follow what the unit can mean: a percentage or a trim is read to a tenth, a temperature in whole degrees, a voltage to the hundredth of a volt and a ratio to a thousandth.
 */

/** The decimals each unit is shown with, keyed by the unit text a sample carries. */
const DECIMALS: Readonly<Record<string, number>> = {
  "%": 1,
  "°C": 0,
  V: 2,
  rpm: 0,
  "km/h": 0,
  kPa: 0,
  Pa: 0,
  ratio: 3,
  "g/s": 2,
  mA: 2,
  "L/h": 2,
  "°": 2,
  "° before TDC": 1,
  s: 0,
  min: 0,
  km: 0,
};

/** The decimals for a unit with no entry: enough to show the reading without float noise. */
const FALLBACK_DECIMALS = 3;

/** The decimals a reading in `unit` is shown with. */
export function decimalsFor(unit: string): number {
  return DECIMALS[unit] ?? FALLBACK_DECIMALS;
}

/**
 * The reading as text without its unit. Text readings (statuses, fault codes) pass through unchanged. A unitless number that is whole shows no decimals, so a counter is not shown as 12.000; a number with no known unit has trailing zeros removed.
 */
export function formatReading(value: number | string, unit: string): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return String(value);
  const known = DECIMALS[unit];
  const fixed = value.toFixed(known ?? FALLBACK_DECIMALS);
  const text = known === undefined ? String(Number(fixed)) : fixed;
  // A small negative that rounds to zero would otherwise read as "-0".
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** The reading with its unit after it, as the screens print it. */
export function formatReadingWithUnit(value: number | string, unit: string): string {
  const text = formatReading(value, unit);
  return unit === "" || typeof value === "string" ? text : `${text} ${unit}`;
}
