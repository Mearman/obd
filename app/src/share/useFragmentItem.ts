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
 */
export function useFragmentItem(
  fragment: string | undefined,
  client: DiagnosticsClient,
): FragmentItem {
  const [state, setState] = useState<{ readonly fragment: string; readonly item: FragmentItem }>();
  useEffect(() => {
    if (fragment === undefined) return;
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
  }, [fragment, client]);
  if (fragment === undefined) return { status: "none" };
  return state?.fragment === fragment ? state.item : { status: "resolving" };
}
