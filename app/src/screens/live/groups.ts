/** How the Live screen groups values: one place maps a value's name to a heading. */

/** The headings, in the order they are shown. */
export const VALUE_GROUPS = [
  "Engine",
  "Fuel and mixture",
  "Emissions and catalyst",
  "Electrical",
  "Counters and status",
] as const;

/** One heading of {@link VALUE_GROUPS}. */
export type ValueGroup = (typeof VALUE_GROUPS)[number];

/** Patterns tried in order against a value's label (the name its samples carry); the first match wins, and a label that matches none is an engine value. */
const RULES: readonly (readonly [RegExp, ValueGroup])[] = [
  [
    /fault codes|since codes cleared|warning lamp|warm-ups|run time|obd standard/i,
    "Counters and status",
  ],
  [/catalyst|egr|evaporative|secondary air|purge/i, "Emissions and catalyst"],
  [/module voltage|battery|supply/i, "Electrical"],
  [/fuel|oxygen sensor|lambda|equivalence ratio|ethanol/i, "Fuel and mixture"],
];

/** The heading a value is listed under. */
export function groupOf(label: string): ValueGroup {
  for (const [pattern, group] of RULES) if (pattern.test(label)) return group;
  return "Engine";
}

/** Rows split by heading in heading order, leaving out headings with no row; rows keep their order within one. */
export function groupRows<Row>(
  rows: readonly Row[],
  labelOf: (row: Row) => string,
): readonly { readonly group: ValueGroup; readonly rows: readonly Row[] }[] {
  return VALUE_GROUPS.map((group) => ({
    group,
    rows: rows.filter((row) => groupOf(labelOf(row)) === group),
  })).filter((entry) => entry.rows.length > 0);
}
