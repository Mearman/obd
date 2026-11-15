import { useSyncExternalStore } from "react";

/** The width from which the Session page shows several sections at once, matching the two-column layout in `session.css.ts`. */
export const WIDE_QUERY = "(min-width: 1024px)";

function subscribe(listener: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}

function snapshot(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}

/** Whether the viewport is wide enough for several Session sections side by side. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
