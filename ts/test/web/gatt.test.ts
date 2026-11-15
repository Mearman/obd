import { describe, expect, it } from "vitest";
import { TransportError } from "../../src/core/index.js";
import { normaliseUuid, pickDataChannel, type GattCharacteristic } from "../../src/web/gatt.js";

const base = "-0000-1000-8000-00805f9b34fb";
const svc = (short: string): string => `0000${short}${base}`;

const generic: GattCharacteristic = {
  service: svc("1800"),
  uuid: svc("2a00"),
  properties: ["notify", "write"],
};

describe("normaliseUuid", () => {
  it("expands 16-bit and 32-bit forms and lower-cases", () => {
    expect(normaliseUuid("18F0")).toBe(svc("18f0"));
    expect(normaliseUuid("0000FFF0")).toBe(svc("fff0"));
    expect(normaliseUuid("E7810A71-73AE")).toBe("e7810a71-73ae");
  });
});

describe("pickDataChannel", () => {
  it("skips the standard services and takes the first service with both roles", () => {
    const characteristics: GattCharacteristic[] = [
      generic,
      { service: svc("fff0"), uuid: svc("fff1"), properties: ["read"] },
      { service: svc("ffe0"), uuid: svc("ffe1"), properties: ["notify", "write-without-response"] },
      { service: svc("18f0"), uuid: svc("2af0"), properties: ["notify"] },
      { service: svc("18f0"), uuid: svc("2af1"), properties: ["write"] },
    ];
    expect(pickDataChannel(characteristics)).toEqual({
      service: svc("ffe0"),
      notify: svc("ffe1"),
      write: svc("ffe1"),
      writeWithResponse: false,
    });
  });

  it("combines a notify and a write characteristic of one service, writing with response", () => {
    const characteristics: GattCharacteristic[] = [
      { service: svc("18f0"), uuid: svc("2af0"), properties: ["indicate"] },
      { service: svc("18f0"), uuid: svc("2af1"), properties: ["write"] },
    ];
    expect(pickDataChannel(characteristics)).toEqual({
      service: svc("18f0"),
      notify: svc("2af0"),
      write: svc("2af1"),
      writeWithResponse: true,
    });
  });

  it("honours service, notify and write overrides, short or prefixed", () => {
    const characteristics: GattCharacteristic[] = [
      { service: svc("ffe0"), uuid: svc("ffe1"), properties: ["notify", "write"] },
      { service: svc("18f0"), uuid: svc("2af0"), properties: ["notify"] },
      { service: svc("18f0"), uuid: svc("2af1"), properties: ["write"] },
      { service: svc("18f0"), uuid: svc("2af2"), properties: ["write"] },
    ];
    expect(pickDataChannel(characteristics, { service: "18f0" }).notify).toBe(svc("2af0"));
    expect(pickDataChannel(characteristics, { service: "18f0", write: "2af2" }).write).toBe(
      svc("2af2"),
    );
    expect(pickDataChannel(characteristics, { service: "0000ffe0" }).service).toBe(svc("ffe0"));
  });

  it("throws TransportError when no service has both roles", () => {
    expect(() => pickDataChannel([generic])).toThrow(TransportError);
    const split: GattCharacteristic[] = [
      { service: svc("fff0"), uuid: svc("fff1"), properties: ["notify"] },
      { service: svc("fff2"), uuid: svc("fff3"), properties: ["write"] },
    ];
    expect(() => pickDataChannel(split)).toThrow(TransportError);
    expect(() => pickDataChannel(split, { service: "ffff" })).toThrow(TransportError);
  });
});
