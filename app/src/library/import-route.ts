import { CAPTURE_FORMAT, PLAN_FORMAT, checkProfile, runExportSchema } from "obd-read";

/** Where an imported file's text goes: a run's CSV or TSV export to the runs, a capture, saved scan or transcript to the captures, or nowhere, with the reason the Library does not keep it. */
export type ImportRoute =
  | { readonly kind: "run" }
  | { readonly kind: "capture" }
  | { readonly kind: "refused"; readonly reason: string };

/** A line an adapter transcript holds: a timestamp, a space, then `>` for a request or `<` for a reply (the line format the capture importer reads). */
const TRANSCRIPT_LINE = /^\S+ [<>]( |$)/;

/** The JSON value of `text`, or undefined when it is not JSON. */
function parsedJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (caught) {
    if (caught instanceof SyntaxError) return undefined;
    throw caught;
  }
}

function formatOf(data: unknown): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, "format") : undefined;
}

/**
 * Tells from a file's text which history it holds, so one import control takes every kind the Library lists.
 *
 * A JSON object is a capture or a saved scan unless it is a run's JSON export, a recording plan or a vehicle profile, which the Library does not import (a run is read back from its CSV or TSV export, plans open on the Guide screen and profiles in Settings). A JSON document that does not parse goes to the capture importer, which reports the syntax error. Other text is a transcript when its first line is a transcript line, a run's table when that line is comma or tab separated, and otherwise a transcript, whose importer lists the lines it could not read.
 */
export function importRoute(text: string): ImportRoute {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("{")) {
    const data = parsedJson(trimmed);
    const format = formatOf(data);
    if (format === CAPTURE_FORMAT) return { kind: "capture" };
    if (format === runExportSchema.shape.format.value) {
      return {
        kind: "refused",
        reason: "That file is a run's JSON export. Import the run's CSV or TSV export instead.",
      };
    }
    if (format === PLAN_FORMAT) {
      return {
        kind: "refused",
        reason: "That file is a recording plan. Open it on the Guide screen.",
      };
    }
    if (data !== undefined && checkProfile(data, "file").length === 0) {
      return {
        kind: "refused",
        reason: "That file is a vehicle profile. Import profiles in Settings.",
      };
    }
    return { kind: "capture" };
  }
  const first = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (TRANSCRIPT_LINE.test(first)) return { kind: "capture" };
  // A run export's header always holds at least its two fixed columns, so it always has a delimiter.
  if (first.includes(",") || first.includes("\t")) return { kind: "run" };
  return { kind: "capture" };
}
