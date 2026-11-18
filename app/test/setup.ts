import "@testing-library/jest-dom/vitest";
import { cleanup, configure, prettyDOM } from "@testing-library/react";
import { afterEach, aroundEach } from "vitest";
import { installMatchMedia, setWideLayout } from "./media";
import { budgetEach, type WorkBudget } from "./work-budget";

/**
 * The work one app test may do. The processor time is a wide margin over the heaviest app test, leaving room for a slower processor in CI; the idle limit is far longer than any timer the app waits on, so only a wait for something that never happens reaches it.
 */
const APP_TEST_BUDGET: WorkBudget = {
  processorMs: 15_000,
  sampleMs: 50,
  idleSamples: 200,
  idleProcessorMs: 1,
};

/** The largest delay a timer accepts; a longer one fires at once. */
const LARGEST_TIMER_DELAY = 2 ** 31 - 1;

// Testing Library's waits give up after a fixed elapsed time, which a busy machine reaches on correct tests; at the largest delay a timer accepts they never give up, and the work budget decides instead. Vitest's own elapsed-time limits are off in the config for the same reason.
configure({ asyncUtilTimeout: LARGEST_TIMER_DELAY });

/** What the page showed, for an error saying a test ran out of work budget; node-environment suites have no page. */
function describePage(): string {
  if (typeof document === "undefined") return "";
  const page = prettyDOM(document.body, 4000);
  return page === false ? "" : `The page:\n${page}`;
}

const budgeted = budgetEach(APP_TEST_BUDGET, describePage);

// The hook's own limit is in elapsed time, so it is off: the budget limits the test and its hooks inside it.
aroundEach((runTest, { task }) => budgeted(runTest, task.name), 0);

afterEach(cleanup);
// The address names the active screen, so a test must not start on the previous test's.
afterEach(() => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
});

// jsdom lacks the pointer-capture, scrolling and resize APIs Radix uses.
class ResizeObserverStub {
  observe(): void {
    // Nothing to observe in jsdom.
  }
  unobserve(): void {
    // Nothing to observe in jsdom.
  }
  disconnect(): void {
    // Nothing to observe in jsdom.
  }
}
// Suites that opt into the node environment (the SQLite engine's) have no DOM to patch.
if (typeof Element !== "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {
    // jsdom has no layout or pointer capture.
  };
  Element.prototype.releasePointerCapture = () => {
    // jsdom has no layout or pointer capture.
  };
  Element.prototype.scrollIntoView = () => {
    // jsdom has no layout or pointer capture.
  };
  installMatchMedia();
  afterEach(() => {
    setWideLayout(false);
  });
}
