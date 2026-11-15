import type { Capabilities } from "obd-read/web";
import { describe, expect, it } from "vitest";
import { adapterAvailability, browserFamily } from "../src/connect/availability";

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

function caps(overrides: Partial<Capabilities>): Capabilities {
  return {
    webSerial: true,
    webBluetooth: true,
    webUsb: true,
    secureContext: true,
    usable: true,
    issues: [],
    ...overrides,
  };
}

describe("browserFamily", () => {
  it.each([
    [CHROME_ANDROID, 5, "chromium"],
    [EDGE, 0, "chromium"],
    [IPHONE_CHROME, 5, "ios"],
    [SAFARI_MAC, 0, "safari"],
    [SAFARI_MAC, 5, "ios"],
    [FIREFOX, 0, "firefox"],
  ] as const)("classifies %s", (userAgent, touchPoints, expected) => {
    expect(browserFamily(userAgent, touchPoints)).toBe(expected);
  });
});

describe("adapterAvailability", () => {
  it("allows everything in Chrome on a secure page, and always the simulator", () => {
    const result = adapterAvailability(caps({}), "chromium");
    expect(result.webbluetooth).toEqual({ available: true, reason: undefined });
    expect(result.webserial.available).toBe(true);
    expect(result.simulator.available).toBe(true);
  });

  it("explains that iOS browsers share Safari's engine", () => {
    const result = adapterAvailability(
      caps({ webSerial: false, webBluetooth: false, webUsb: false, usable: false }),
      "ios",
    );
    expect(result.webbluetooth.available).toBe(false);
    expect(result.webbluetooth.reason).toMatch(/every iOS browser uses Safari/);
    expect(result.simulator.available).toBe(true);
  });

  it("names Safari and Firefox", () => {
    const missing = caps({ webSerial: false, webBluetooth: false, webUsb: false, usable: false });
    expect(adapterAvailability(missing, "safari").webserial.reason).toMatch(
      /not available in Safari/,
    );
    expect(adapterAvailability(missing, "firefox").webserial.reason).toMatch(
      /not available in Firefox/,
    );
  });

  it("blames the page, not the browser, when Chrome is on an insecure page", () => {
    const insecure = caps({
      webSerial: false,
      webBluetooth: false,
      webUsb: false,
      secureContext: false,
      usable: false,
    });
    expect(adapterAvailability(insecure, "chromium").webbluetooth.reason).toMatch(
      /HTTPS or from localhost/,
    );
  });

  it("asks for a secure page even where the API exists", () => {
    const result = adapterAvailability(caps({ secureContext: false, usable: false }), "firefox");
    expect(result.webserial.reason).toMatch(/HTTPS or from localhost/);
  });
});
