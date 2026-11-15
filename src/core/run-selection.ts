/**
 * What a run was started to collect, kept in the run's own record so a run can be resumed after a reload.
 *
 * {@link Storage} holds a run's profile, adapter and notes, not which unit or values it polls. Until it has a place for that, the selection is a final line of the notes, which survive in any storage. {@link withSelection} appends it, and {@link readSelection} and {@link userNotes} read it back, so callers outside the service see notes as the user wrote them. A run a recording plan records carries the plan's name on a final line of its own ({@link withPlan}, {@link recordedPlan}), so the service can tell it from a collection run and never collects into it after a reload.
 *
 * This module is platform-free.
 */

import { collectionRequestSchema } from "./service.js";
import type { CollectionRequest } from "./collector.js";

const MARKER = "\nobd-read-collection: ";
const PLAN_MARKER = "\nobd-read-plan: ";

/** The notes with the selection appended as their last line. */
export function withSelection(notes: string, request: CollectionRequest): string {
  return `${notes}${MARKER}${JSON.stringify(request)}`;
}

function split(notes: string): { text: string; selection: string | undefined } {
  const at = notes.lastIndexOf(MARKER);
  if (at < 0) return { text: notes, selection: undefined };
  return { text: notes.slice(0, at), selection: notes.slice(at + MARKER.length) };
}

/** The notes as the user wrote them, without the selection or plan line. */
export function userNotes(notes: string): string {
  const plan = notes.lastIndexOf(PLAN_MARKER);
  return split(plan < 0 ? notes : notes.slice(0, plan)).text;
}

/** The notes with the name of the plan that records the run appended as their last line. */
export function withPlan(notes: string, plan: string): string {
  return `${notes}${PLAN_MARKER}${plan}`;
}

/** The name of the plan that recorded the run, or `undefined` for a run no plan recorded. */
export function recordedPlan(notes: string): string | undefined {
  const at = notes.lastIndexOf(PLAN_MARKER);
  return at < 0 ? undefined : notes.slice(at + PLAN_MARKER.length);
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
