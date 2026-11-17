import { shareFragmentOf } from "obd-read";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

/** What a page holds of a share link in its address. */
export interface SharedLink {
  /** The `share=...` fragment the page was opened with, or undefined when there is none. */
  readonly fragment: string | undefined;
  /** Removes the fragment from the address bar and forgets it; the page's path and query stay. */
  readonly clear: () => void;
}

/** Follows the address's `#share=` fragment as the router holds it, so one pasted into an open page and one the app puts there itself both count. */
export function useSharedLink(): SharedLink {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const fragment = shareFragmentOf(hash);

  const navigate = useNavigate();
  const clear = useCallback(() => {
    void navigate({ to: ".", hash: "", replace: true, search: (previous) => previous });
  }, [navigate]);

  return { fragment, clear };
}
