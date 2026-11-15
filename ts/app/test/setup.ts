import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

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
