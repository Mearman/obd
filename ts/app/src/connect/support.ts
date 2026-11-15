import { capabilities, type Capabilities } from "obd-read/web";
import { browserFamily, type BrowserFamily } from "./availability";

/** What the running browser offers, as the Connect screen needs it. */
export interface BrowserSupport {
  readonly capabilities: Capabilities;
  readonly family: BrowserFamily;
}

/** Reads the running page's browser: its hardware APIs, secure context and engine family. */
export function detectBrowserSupport(): BrowserSupport {
  return {
    capabilities: capabilities(),
    family: browserFamily(navigator.userAgent, navigator.maxTouchPoints),
  };
}
