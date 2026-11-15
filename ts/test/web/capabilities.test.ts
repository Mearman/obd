import { describe, expect, it } from "vitest";
import { capabilities } from "../../src/web/capabilities.js";

describe("capabilities", () => {
  it("reports a Chromium page", () => {
    const result = capabilities({
      navigator: { serial: {}, bluetooth: {}, usb: {} },
      isSecureContext: true,
    });
    expect(result).toEqual({
      webSerial: true,
      webBluetooth: true,
      webUsb: true,
      secureContext: true,
      usable: true,
      issues: [],
    });
  });

  it("explains a Safari or Firefox page", () => {
    const result = capabilities({ navigator: {}, isSecureContext: true });
    expect(result.usable).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.issues.join(" ")).toContain("Safari");
  });

  it("reports an insecure page as unusable even with both APIs", () => {
    const result = capabilities({
      navigator: { serial: {}, bluetooth: {}, usb: {} },
      isSecureContext: false,
    });
    expect(result.usable).toBe(false);
    expect(result.secureContext).toBe(false);
    expect(result.issues[0]).toContain("HTTPS");
  });

  it("copes with no navigator at all", () => {
    const result = capabilities({ navigator: undefined, isSecureContext: undefined });
    expect([result.webSerial, result.webBluetooth, result.webUsb, result.usable]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("reports serial alone as usable", () => {
    expect(capabilities({ navigator: { serial: {} }, isSecureContext: true }).usable).toBe(true);
  });

  it("reports WebUSB alone as usable, for a gs_usb CAN adapter", () => {
    const result = capabilities({ navigator: { usb: {} }, isSecureContext: true });
    expect([result.webUsb, result.webSerial, result.usable]).toEqual([true, false, true]);
  });
});
