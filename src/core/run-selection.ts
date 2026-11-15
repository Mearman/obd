/**
 * What a run was started to collect, kept in the run's own record so a run can be resumed after a reload.
 *
 * {@link Storage} holds a run's profile, adapter and notes, not which unit or values it polls. Until it has a place for that, the selection is a final line of the notes, which survive in any storage. {@link withSelection} appends it, and {@link readSelection} and {@link userNotes} read it back, so callers outside the service see notes as the user wrote them.
 *
 * This module is platform-free.
 */

import { collectionRequestSchema } from "./service.js";
import type { CollectionRequest } from "./collector.js";

const MARKER = "\nobd-read-collection: ";

/** The notes with the selection appended as their last line. */
export function withSelection(notes: string, request: CollectionRequest): string {
  return `${notes}${MARKER}${JSON.stringify(request)}`;
}

function split(notes: string): { text: string; selection: string | undefined } {
  const at = notes.lastIndexOf(MARKER);
  if (at < 0) return { text: notes, selection: undefined };
  return { text: notes.slice(0, at), selection: notes.slice(at + MARKER.length) };
}

/** The notes as the user wrote them, without the selection line. */
export function userNotes(notes: string): string {
  return split(notes).text;
}

/**
 * What the run was started to collect.
 *
 * @returns Every legislated value when the notes carry no selection.
 * @throws ZodError when the selection line is not a valid selection.
 */
export function readSelection(notes: string): CollectionRequest {
  const { selection } = split(notes);
  if (selection === undefined) return {};
  return collectionRequestSchema.parse(JSON.parse(selection));
}
