import type { CaptureSummary, Origin, Run, ScanReportSummary } from "obd-read";
import { ALL_ORIGINS } from "../origin/origins";
import type { SelectOption } from "../ui";

/** The kinds of history the Library lists. */
export const LIBRARY_KINDS = ["run", "capture", "report"] as const;

/** One kind of history: a collection run, a raw capture or a saved scan report. */
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** How each kind reads in a row's kind badge. */
export const KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  run: "Run",
  capture: "Capture",
  report: "Report",
};

/** How each kind reads where it names many of them, as a filter choice or a group's heading. */
export const KIND_PLURALS: Readonly<Record<LibraryKind, string>> = {
  run: "Runs",
  capture: "Captures",
  report: "Reports",
};

/** What a row of every kind shows: when it was taken, where it came from and which profile read it. */
interface ItemBase {
  readonly id: string;
  /** When the run started, the capture started or the report was taken, in milliseconds since the epoch. */
  readonly at: number;
  readonly origin: Origin;
  /** The profile it was read with; `null` for a capture read with none. */
  readonly profile: string | null;
  /** The VIN of the car it was read from, trimmed and in upper case; `null` when it is not known. */
  readonly vin: string | null;
}

/** One row of the Library. */
export type LibraryItem =
  | (ItemBase & { readonly kind: "run"; readonly run: Run; readonly samples: number })
  | (ItemBase & { readonly kind: "capture"; readonly capture: CaptureSummary })
  | (ItemBase & { readonly kind: "report"; readonly report: ScanReportSummary });

/** The item the Library has open in its viewer. */
export interface LibraryOpen {
  readonly kind: LibraryKind;
  readonly id: string;
}

/** The kind filter's value for every kind. */
export const ALL_KINDS = "all";

/** The choices of the kind filter: every kind, then each one. */
export const KIND_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: ALL_KINDS, label: "All" },
  ...LIBRARY_KINDS.map((kind) => ({ value: kind, label: KIND_PLURALS[kind] })),
];

/** What the Library says when the kind filter's value finds nothing of any origin. */
export const EMPTY_NOTES: Readonly<Record<LibraryKind | typeof ALL_KINDS, string>> = {
  all: "Nothing here yet. Scan, capture or collect a run on the Session screen, or import a file.",
  run: "No runs yet.",
  capture: "No captures yet. Capture from Connect or Scan, or import a file.",
  report: "No saved reports yet.",
};

/** What the Library says when the kind filter's value finds nothing of the chosen origin. */
export function emptyNote(kinds: string, origin: string): string {
  if (origin !== ALL_ORIGINS) return "Nothing of this kind and origin.";
  return isLibraryKind(kinds) ? EMPTY_NOTES[kinds] : EMPTY_NOTES.all;
}

/** Whether `value` names one kind, as the kind filter's values other than {@link ALL_KINDS} do. */
export function isLibraryKind(value: string): value is LibraryKind {
  return LIBRARY_KINDS.some((kind) => kind === value);
}

/** Whether the kind filter's value `shown` lets rows of `kind` through. */
export function kindShown(shown: string, kind: LibraryKind): boolean {
  return shown === ALL_KINDS || shown === kind;
}

/** A key unique across kinds, since ids are only unique within one. */
export function itemKey(item: Pick<LibraryItem, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

/** A run as a Library row. */
export function runItem(run: Run, samples: number): LibraryItem {
  return {
    kind: "run",
    id: run.id,
    at: run.startedAt,
    origin: run.origin,
    profile: run.profile,
    vin: run.vin,
    run,
    samples,
  };
}

/** A capture as a Library row. */
export function captureItem(capture: CaptureSummary): LibraryItem {
  return {
    kind: "capture",
    id: capture.id,
    at: capture.startedAt,
    origin: capture.origin,
    profile: capture.profile,
    vin: capture.vin,
    capture,
  };
}

/** A saved report as a Library row. */
export function reportItem(report: ScanReportSummary): LibraryItem {
  return {
    kind: "report",
    id: report.id,
    at: report.takenAt,
    origin: report.origin,
    profile: report.profile,
    vin: report.vin,
    report,
  };
}
