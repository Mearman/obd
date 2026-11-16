import { useState } from "react";

/** What the search field holds between the address's arrivals. */
interface Draft {
  /** The text the field shows. */
  readonly text: string;
  /** The address value this draft last reconciled with. */
  readonly seen: string;
  /** Values this field wrote that the address has not yet caught up past, so their return is an echo, not a change from elsewhere. */
  readonly pending: ReadonlySet<string>;
  /** Whether an edit is under way, so the next change replaces its history entry instead of adding one. */
  readonly editing: boolean;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The search field's text, kept here while the person types so the field never waits on the address, with what to call as it changes and as it loses focus.
 *
 * The first change of an edit adds a history entry and the rest replace it, so Back undoes the whole edit; the field losing focus ends the edit. The address returning one of the field's own writes leaves the typed text alone, and once the address has reached the field's last write any later value is a change from elsewhere, as Back and Forward are. Such a value replaces the text in the same render that brings it, so the field never shows a frame behind the address, and it ends any edit under way, so the next change adds an entry instead of overwriting the one Back reached.
 *
 * @param search The search the address holds.
 * @param write Moves the address to `text`, replacing the current history entry when `replace` is true.
 */
export function useSearchText(
  search: string,
  write: (text: string, replace: boolean) => void,
): { readonly text: string; readonly change: (text: string) => void; readonly end: () => void } {
  const [draft, setDraft] = useState<Draft>({
    text: search,
    seen: search,
    pending: NONE,
    editing: false,
  });
  let current = draft;
  // Reconciling during render rather than in an effect is React's pattern for state that follows a prop: the render that brings the new search re-runs with the adjusted draft before anything commits.
  if (search !== draft.seen) {
    current = draft.pending.has(search)
      ? { ...draft, seen: search, pending: search === draft.text ? NONE : draft.pending }
      : { text: search, seen: search, pending: NONE, editing: false };
    setDraft(current);
  }
  return {
    text: current.text,
    change: (next) => {
      write(next, current.editing);
      setDraft((before) => ({
        ...before,
        text: next,
        pending: new Set([...before.pending, next]),
        editing: true,
      }));
    },
    end: () => {
      setDraft((before) => ({
        ...before,
        editing: false,
        pending: before.seen === before.text ? NONE : before.pending,
      }));
    },
  };
}
