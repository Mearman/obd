/**
 * A `window.matchMedia` for jsdom, which has none and no layout. Every query is false except the Session screen's wide layout, which follows {@link setWideLayout}; a test that needs another answer replaces `window.matchMedia` itself.
 */
import { WIDE_QUERY } from "../src/session/useWideLayout";

let wide = false;
const lists = new Set<FakeMediaQueryList>();

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;

  constructor(media: string) {
    super();
    this.media = media;
    lists.add(this);
  }

  get matches(): boolean {
    return this.media === WIDE_QUERY && wide;
  }

  // The deprecated listener methods are not used by the app; a call to one is a mistake to see.
  addListener(): void {
    throw new Error("matchMedia: use addEventListener");
  }

  removeListener(): void {
    throw new Error("matchMedia: use removeEventListener");
  }
}

/** Installs the fake on `window`. */
export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => new FakeMediaQueryList(query),
  });
}

/** Makes the viewport wide enough for the Session screen's two-column layout, or narrow again, and tells every listener. */
export function setWideLayout(next: boolean): void {
  wide = next;
  for (const list of lists) list.dispatchEvent(new Event("change"));
}
