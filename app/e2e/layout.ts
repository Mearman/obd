import { expect, type Page } from "@playwright/test";

/** The smallest touch target, in CSS pixels. */
export const MIN_TARGET = 44;

/** What a person taps or types into. */
const INTERACTIVE =
  'button, a[href], summary, select, textarea, [role="tab"], [role="switch"], [role="combobox"], [role="checkbox"], [role="slider"], input:not([hidden]):not([type="hidden"]), label:has(> input[type="checkbox"])';

/** How far the page is wider than the window, in CSS pixels; above zero means it scrolls sideways. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** The visible controls smaller than {@link MIN_TARGET} in either direction, each named with its size. */
export async function undersizedTargets(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ selector, min }) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.getClientRects().length > 0)
        // A checkbox inside its label is reached through the label, whose whole row is the target.
        .filter(
          (element) =>
            !(
              element instanceof HTMLInputElement &&
              element.type === "checkbox" &&
              element.closest("label") !== null
            ),
        )
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width < min || box.height < min)
        .map(
          ({ element, box }) =>
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent).trim().slice(0, 30)}" ${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
        ),
    { selector: INTERACTIVE, min: MIN_TARGET },
  );
}

/**
 * The buttons, tabs and badges whose text runs onto more than one line, each named with its text. Left out: a label meant to wrap, such as a sentence in a badge (`data-wrap`), and a button that spans its container, which wraps at word boundaries to fit like a line of text.
 */
export async function wrappedLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // The narrowest phones wrap a label rather than scroll sideways.
    if (window.innerWidth < 360) return [];
    const isBadge = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return style.display === "inline-flex" && parseFloat(style.borderTopLeftRadius) >= 100;
    };
    // Text on one line has rects whose vertical ranges overlap, whatever their glyph heights; a wrapped line starts below the one before.
    const lines = (element: HTMLElement): number => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((first, second) => first.top - second.top);
      let count = 0;
      let bottom = -Infinity;
      for (const rect of rects) {
        if (rect.top >= bottom - 1) {
          count += 1;
          bottom = rect.bottom;
        } else bottom = Math.max(bottom, rect.bottom);
      }
      return count;
    };
    const spansParent = (element: HTMLElement): boolean => {
      const parent = element.parentElement;
      return parent !== null && element.getBoundingClientRect().width >= parent.clientWidth * 0.9;
    };
    return [...document.querySelectorAll<HTMLElement>("button, [role=tab], span, div")]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => !element.closest("[data-wrap]"))
      .filter(
        (element) =>
          element.matches("button, [role=tab]") || (element.tagName === "SPAN" && isBadge(element)),
      )
      .filter(
        (element) => lines(element) > 1 && !(element.tagName === "BUTTON" && spansParent(element)),
      )
      .map(
        (element) =>
          `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}"`,
      );
  });
}

/** Checks that the page does not scroll sideways, that every control is large enough and that no label wraps. */
export async function fits(page: Page, what: string): Promise<void> {
  expect(await horizontalOverflow(page), `${what} overflows horizontally`).toBeLessThanOrEqual(0);
  expect(
    await undersizedTargets(page),
    `${what} has targets under ${String(MIN_TARGET)} px`,
  ).toEqual([]);
  expect(await wrappedLabels(page), `${what} has a label that wraps`).toEqual([]);
}
