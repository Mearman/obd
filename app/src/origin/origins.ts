import type { Origin } from "obd-read";
import type { SelectOption } from "../ui";

/** How each origin reads in a badge. */
export const ORIGIN_LABELS: Readonly<Record<Origin, string>> = {
  local: "Read here",
  shared: "Shared",
  imported: "Imported",
};

/** The origin filter's value for every origin. */
const EVERY_ORIGIN = "all";

/** The choices of an origin filter: every origin, then each one. */
export const ORIGIN_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: EVERY_ORIGIN, label: "All" },
  { value: "local", label: "Read here" },
  { value: "shared", label: "Shared" },
  { value: "imported", label: "Imported" },
];

/** The filter's starting value. */
export const ALL_ORIGINS = EVERY_ORIGIN;

/** The query field for a filter value: `{}` for every origin, `{ origin }` for one. */
export function originQuery(value: string): { readonly origin?: Origin } {
  switch (value) {
    case "local":
    case "shared":
    case "imported":
      return { origin: value };
    default:
      return {};
  }
}
