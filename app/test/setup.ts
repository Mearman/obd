import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installMatchMedia, setWideLayout } from "./media";

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
