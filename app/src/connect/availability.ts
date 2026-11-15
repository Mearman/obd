import type { Capabilities } from "obd-read/web";
import type { AdapterKind } from "../diagnostics/client";

/** Whether one adapter choice can be used here, and the reason when it cannot. */
export interface Availability {
  readonly available: boolean;
  /** Why the choice is unavailable, in plain language; undefined when available. */
  readonly reason: string | undefined;
}

/** The browser family, as far as it decides which hardware APIs exist. */
export type BrowserFamily = "ios" | "safari" | "firefox" | "chromium" | "other";

/**
 * Classifies a user agent string. Every iOS and iPadOS browser uses Safari's engine, so it is
 * checked first; desktop Safari has no Chrome token; Chromium browsers (Chrome, Edge) are the
 * only ones that implement Web Serial and Web Bluetooth.
 */
export function browserFamily(userAgent: string, maxTouchPoints = 0): BrowserFamily {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  // iPadOS reports a Macintosh user agent but has touch points.
  if (userAgent.includes("Macintosh") && maxTouchPoints > 1) return "ios";
  if (/Firefox|FxiOS/.test(userAgent)) return "firefox";
  if (/Chrome|Chromium|Edg\//.test(userAgent)) return "chromium";
  if (userAgent.includes("Safari")) return "safari";
  return "other";
}

const SECURE_CONTEXT_REASON =
  "Open this page over HTTPS or from localhost. Browsers hide Bluetooth and serial access on other pages.";

/** The explanation for a missing API in `family`, naming the supported browsers. */
function missingApi(api: string, family: BrowserFamily): string {
  switch (family) {
    case "ios":
      return `${api} is not available on iPhone or iPad: every iOS browser uses Safari's engine, which does not implement it. Use Chrome or Edge on Android or a computer, or choose the simulator.`;
    case "safari":
      return `${api} is not available in Safari. Use Chrome or Edge on Android or a computer, or choose the simulator.`;
    case "firefox":
      return `${api} is not available in Firefox. Use Chrome or Edge on Android or a computer, or choose the simulator.`;
    case "chromium":
    case "other":
      return `${api} is not available in this browser. It needs a recent Chrome or Edge on Android or a computer, or choose the simulator.`;
  }
}

/**
 * Decides, for each adapter choice, whether it can be used and why not. The simulator is always
 * available. `capabilities` comes from `obd-read/web`, `family` from {@link browserFamily}.
 */
export function adapterAvailability(
  capabilities: Capabilities,
  family: BrowserFamily,
): Readonly<Record<AdapterKind, Availability>> {
  const unavailable = (reason: string): Availability => ({ available: false, reason });
  const hardware = (present: boolean, api: string): Availability => {
    // Chromium hides both APIs on an insecure page, so a missing API there means the page, not the browser.
    const chromiumLike = family === "chromium" || family === "other";
    if (!capabilities.secureContext && chromiumLike) return unavailable(SECURE_CONTEXT_REASON);
    if (!present) return unavailable(missingApi(api, family));
    if (!capabilities.secureContext) return unavailable(SECURE_CONTEXT_REASON);
    return { available: true, reason: undefined };
  };
  return {
    webserial: hardware(capabilities.webSerial, "Web Serial"),
    webbluetooth: hardware(capabilities.webBluetooth, "Web Bluetooth"),
    simulator: { available: true, reason: undefined },
  };
}
