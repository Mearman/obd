import { useNavigate, useSearch } from "@tanstack/react-router";
import { isLibraryKind, type LibraryOpen } from "../library/items";
import { DEFAULT_SCREEN, type ScreenName } from "../router/search";

/** Where the app is: the active screen and, on the Library, the item open. */
export interface AppLocation {
  readonly screen: ScreenName;
  readonly opened: LibraryOpen | undefined;
}

/** The parts of a location a navigation changes; one left out keeps its value, and only the Library holds an item. */
export interface Navigation {
  readonly screen?: ScreenName;
  readonly opened?: LibraryOpen | undefined;
}

function parseItem(value: string | undefined): LibraryOpen | undefined {
  if (value === undefined) return undefined;
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  return at > 0 && id !== "" && isLibraryKind(kind) ? { kind, id } : undefined;
}

/**
 * The active screen and open Library item as the router holds them in the address query (`?screen=library&item=run:<id>`), with a function that moves to another. Each move is one history entry, so Back returns to the previous place. The default screen is left out of the address, and so is an item on any other screen; other query parameters and the `#share=` fragment are kept.
 */
export function useAppLocation(): readonly [AppLocation, (change: Navigation) => void] {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const screen = search.screen ?? DEFAULT_SCREEN;
  const location: AppLocation = {
    screen,
    opened: screen === "library" ? parseItem(search.item) : undefined,
  };
  const move = (change: Navigation): void => {
    const next = change.screen ?? location.screen;
    const opened =
      next === "library" ? ("opened" in change ? change.opened : location.opened) : undefined;
    void navigate({
      to: ".",
      hash: true,
      search: (previous) => ({
        ...previous,
        screen: next === DEFAULT_SCREEN ? undefined : next,
        item: opened === undefined ? undefined : `${opened.kind}:${opened.id}`,
      }),
    });
  };
  return [location, move];
}
