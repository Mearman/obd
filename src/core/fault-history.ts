/**
 * Fault codes in a collection run: how a run records which codes the car reports, and how the changes are read back.
 *
 * A generic run polls the legislated stored (mode 03), pending (07) and permanent (0A) codes beside its live values. Each list is one signal, stored as a text sample whenever the list changes, and always once when collection starts, so a code that was present from the beginning is told apart from one that appeared later. The value is the codes, sorted and separated by spaces, or {@link NO_CODES} when there are none. Because the samples are ordinary samples, the exports, the live table and the share link carry them with no change to storage. This module is platform-free.
 */

import { z } from "zod";
import type { Sample } from "./storage.js";

/** The kinds of fault code list a run records. */
export const FAULT_LISTS = ["stored", "pending", "permanent"] as const;

/** One of the fault code lists a run records. */
export type FaultList = (typeof FAULT_LISTS)[number];

/** The signal each list is recorded under. */
export const FAULT_SIGNALS: Readonly<Record<FaultList, string>> = {
  stored: "stored fault codes",
  pending: "pending fault codes",
  permanent: "permanent fault codes",
};

/** The value recorded when a list holds no codes. */
export const NO_CODES = "none";

/** The sample value for a list: its codes, each once, sorted and separated by spaces, or {@link NO_CODES}. A code several units report is one entry. */
export function faultSampleValue(codes: Iterable<string>): string {
  const unique = [...new Set(codes)].sort();
  return unique.length === 0 ? NO_CODES : unique.join(" ");
}

/** The codes a sample value holds. */
export function parseFaultValue(value: string): string[] {
  return value === NO_CODES ? [] : value.split(" ").filter((code) => code !== "");
}

/** Which list a signal records, or `undefined` for any other signal. */
export function faultListOf(signal: string): FaultList | undefined {
  return FAULT_LISTS.find((list) => FAULT_SIGNALS[list] === signal);
}

/** One change in a run's fault codes, as a run's JSON export lists it. */
export const faultEventSchema = z.object({
  /** When the change was seen: the time of the poll that found it, not of the fault. */
  timestamp: z.number(),
  list: z.enum(FAULT_LISTS),
  code: z.string(),
  change: z.enum(["appeared", "disappeared"]),
  /** True for a code present at the first poll of its list, so it was there before collection began. */
  atStart: z.boolean(),
});

/** One change in a run's fault codes. */
export type FaultEvent = Readonly<z.output<typeof faultEventSchema>>;

/**
 * The changes in a run's fault code lists, oldest first, from its samples in time order.
 *
 * The first sample of a list reports every code it holds as appeared with `atStart` set. Each later sample reports the codes added since the previous one as appeared and those gone as disappeared, in code order. A sample whose value did not change reports nothing, and a sample of any other signal is ignored.
 */
export function faultEvents(samples: readonly Sample[]): FaultEvent[] {
  const previous = new Map<FaultList, readonly string[]>();
  const events: FaultEvent[] = [];
  for (const sample of samples) {
    const list = faultListOf(sample.signal);
    if (list === undefined || typeof sample.value !== "string") continue;
    const now = parseFaultValue(sample.value);
    const before = previous.get(list);
    const atStart = before === undefined;
    for (const code of now) {
      if (!(before ?? []).includes(code)) {
        events.push({ timestamp: sample.timestamp, list, code, change: "appeared", atStart });
      }
    }
    for (const code of before ?? []) {
      if (!now.includes(code)) {
        events.push({
          timestamp: sample.timestamp,
          list,
          code,
          change: "disappeared",
          atStart: false,
        });
      }
    }
    previous.set(list, now);
  }
  return events;
}
