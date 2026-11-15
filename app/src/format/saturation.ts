/**
 * Counters that stop counting at the top of their field.
 *
 * The legislated counters are held in one byte or two (SAE J1979, as ISO 15031-5 repeats it), and a control module that reaches the largest value keeps reporting it instead of wrapping round. A reading at that value therefore means "this long or longer", not the figure itself, and a display that prints it plainly misleads. The table holds the counters the app decodes whose field is that narrow, with the largest value each can carry.
 */

/** What is shown beside a reading that is at its field's maximum. */
export const SATURATED_NOTE = "at its maximum, so the real value is higher";

/** The largest value of each counter, keyed by the label its samples carry. */
export const SATURATING_MAXIMA: Readonly<Record<string, number>> = {
  "warm-ups since codes cleared": 255,
  "distance since codes cleared": 65_535,
  "distance with warning lamp on": 65_535,
  "time since codes cleared": 65_535,
  "time run with warning lamp on": 65_535,
  "run time since engine start": 65_535,
};

/** Whether a reading of `signal` is at the maximum its field can carry. */
export function isSaturated(signal: string, value: number | string): boolean {
  const maximum = SATURATING_MAXIMA[signal];
  return maximum !== undefined && typeof value === "number" && value >= maximum;
}
