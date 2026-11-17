import { useEffect, useState } from "react";
import type { DiagnosticsClient } from "../diagnostics/client";
import { findStoredItem } from "../library/stored-item";
import type { LibraryOpen } from "../library/items";

/** What the address's share link turned out to be: not looked up yet, the item this device stores, or someone else's data. */
export type FragmentItem =
  | { readonly status: "none" }
  | { readonly status: "resolving" }
  | { readonly status: "found"; readonly open: LibraryOpen }
  | { readonly status: "foreign" };

/**
 * Looks up the Library item the address's share link carries, so the same link opens the stored item on a device that has it and the shared viewer anywhere else.
 *
 * @param fragment The `share=...` fragment of the address, or undefined when there is none.
 * @param known A link the app made itself for an open item, which needs no lookup: until the lookup answered, the item must not close, so the screen it is on does not change under it.
 */
export function useFragmentItem(
  fragment: string | undefined,
  client: DiagnosticsClient,
  known: { readonly fragment: string; readonly open: LibraryOpen } | undefined,
): FragmentItem {
  const [state, setState] = useState<{ readonly fragment: string; readonly item: FragmentItem }>();
  useEffect(() => {
    if (fragment === undefined || known?.fragment === fragment) return;
    const live = { active: true };
    findStoredItem(client, fragment).then(
      (open) => {
        if (live.active) {
          setState({
            fragment,
            item: open === undefined ? { status: "foreign" } : { status: "found", open },
          });
        }
      },
      () => {
        if (live.active) setState({ fragment, item: { status: "foreign" } });
      },
    );
    return () => {
      live.active = false;
    };
    // `known` only decides whether to look up; a lookup for another fragment restarts with the fragment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment, client]);
  if (fragment === undefined) return { status: "none" };
  if (known?.fragment === fragment) return { status: "found", open: known.open };
  return state?.fragment === fragment ? state.item : { status: "resolving" };
}
