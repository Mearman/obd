import { useCallback, useEffect, useState } from "react";
import { isLibraryKind, type LibraryOpen } from "../library/items";

/** The query parameter that names the active screen. */
export const SCREEN_PARAM = "screen";

/** The query parameter that names the Library item open on its own page, as `<kind>:<id>`. */
export const ITEM_PARAM = "item";

/** Where the app is: the active screen and, on the Library, the item open. */
export interface AppLocation<Name extends string> {
  readonly screen: Name;
  readonly opened: LibraryOpen | undefined;
}

/** The parts of a location a navigation changes; one that is left out keeps its value, except that only the Library holds an item. */
export interface Navigation<Name extends string> {
  readonly screen?: Name;
  readonly opened?: LibraryOpen | undefined;
}

function parseItem(value: string | null): LibraryOpen | undefined {
  if (value === null) return undefined;
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  return at > 0 && id !== "" && isLibraryKind(kind) ? { kind, id } : undefined;
}

/**
 * Keeps the active screen and the open Library item in the page's query (`?screen=library&item=run:<id>`), so a reload, a bookmark or a pasted address opens the same place and Back returns to the previous one.
 *
 * `screens` lists every valid name and `fallback` is the one shown, and left out of the address, when the query names none of them. The path and the `#share=` fragment are left as they are, and so is any other query parameter. Each navigation is one history entry.
 */
export function useAppLocation<Name extends string>(
  screens: readonly Name[],
  fallback: Name,
): readonly [AppLocation<Name>, (change: Navigation<Name>) => void] {
  const read = useCallback((): AppLocation<Name> => {
    const query = new URLSearchParams(window.location.search);
    const value = query.get(SCREEN_PARAM);
    const screen = screens.find((name) => name === value) ?? fallback;
    return { screen, opened: screen === "library" ? parseItem(query.get(ITEM_PARAM)) : undefined };
  }, [screens, fallback]);

  const [location, setLocation] = useState<AppLocation<Name>>(read);

  useEffect(() => {
    const follow = (): void => {
      setLocation(read());
    };
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("popstate", follow);
    };
  }, [read]);

  const navigate = useCallback(
    (change: Navigation<Name>): void => {
      const current = read();
      const screen = change.screen ?? current.screen;
      const opened =
        screen === "library" ? ("opened" in change ? change.opened : current.opened) : undefined;
      const next = { screen, opened };
      setLocation(next);
      const url = new URL(window.location.href);
      if (screen === fallback) url.searchParams.delete(SCREEN_PARAM);
      else url.searchParams.set(SCREEN_PARAM, screen);
      if (opened === undefined) url.searchParams.delete(ITEM_PARAM);
      else url.searchParams.set(ITEM_PARAM, `${opened.kind}:${opened.id}`);
      if (url.href !== window.location.href)
        window.history.pushState(window.history.state, "", url);
    },
    [read, fallback],
  );

  return [location, navigate];
}
