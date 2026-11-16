import { useNavigate, useSearch } from "@tanstack/react-router";
import { isLibraryKind, type LibraryOpen } from "../library/items";
import { DEFAULT_VIEW, viewFromSearch, viewToSearch, type LibraryView } from "../library/view";
import { DEFAULT_SCREEN, type ScreenName } from "../router/search";

/** Where the app is: the active screen and, on the Library, the item open and how the list is filtered, sorted and grouped. */
export interface AppLocation {
  readonly screen: ScreenName;
  readonly opened: LibraryOpen | undefined;
  readonly view: LibraryView;
}

/** The parts of a location a navigation changes; one left out keeps its value, and only the Library holds an item and a view. */
export interface Navigation {
  readonly screen?: ScreenName;
  readonly opened?: LibraryOpen | undefined;
  readonly view?: LibraryView;
  /** Replaces the current history entry instead of adding one, as each keystroke after the first of a search does. */
  readonly replace?: boolean;
}

function parseItem(value: string | undefined): LibraryOpen | undefined {
  if (value === undefined) return undefined;
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  return at > 0 && id !== "" && isLibraryKind(kind) ? { kind, id } : undefined;
}

/**
 * The active screen, open Library item and Library view as the router holds them in the address query (`?screen=library&item=run:<id>&kind=run`), with a function that moves to another. Each move is one history entry unless it replaces the current one, so Back returns to the previous place. The default screen and every default of the view are left out of the address, and so are an item and a view on any other screen; other query parameters and the `#share=` fragment are kept.
 */
export function useAppLocation(): readonly [AppLocation, (change: Navigation) => void] {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const screen = search.screen ?? DEFAULT_SCREEN;
  const library = screen === "library";
  const location: AppLocation = {
    screen,
    opened: library ? parseItem(search.item) : undefined,
    view: library ? viewFromSearch(search) : DEFAULT_VIEW,
  };
  const move = (change: Navigation): void => {
    const next = change.screen ?? location.screen;
    const onLibrary = next === "library";
    const opened = onLibrary ? ("opened" in change ? change.opened : location.opened) : undefined;
    const view = onLibrary ? (change.view ?? location.view) : DEFAULT_VIEW;
    void navigate({
      to: ".",
      hash: true,
      replace: change.replace === true,
      search: (previous) => ({
        ...previous,
        screen: next === DEFAULT_SCREEN ? undefined : next,
        item: opened === undefined ? undefined : `${opened.kind}:${opened.id}`,
        ...viewToSearch(view),
      }),
    });
  };
  return [location, move];
}
