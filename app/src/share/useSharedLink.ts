import { shareFragmentOf } from "obd-read";
import { useCallback, useEffect, useState } from "react";

/** What a page holds of a share link in its address. */
export interface SharedLink {
  /** The `share=...` fragment the page was opened with, or undefined when there is none. */
  readonly fragment: string | undefined;
  /** Removes the fragment from the address bar and forgets it; the page's path and query stay. */
  readonly clear: () => void;
}

/** Follows the page's `#share=` fragment, including one pasted into an already open page. */
export function useSharedLink(): SharedLink {
  const [fragment, setFragment] = useState(() => shareFragmentOf(window.location.hash));

  useEffect(() => {
    const follow = (): void => {
      setFragment(shareFragmentOf(window.location.hash));
    };
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
    };
  }, []);

  const clear = useCallback(() => {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    setFragment(undefined);
  }, []);

  return { fragment, clear };
}
