import { describe, expect, it } from "vitest";
import {
  CAN_EFF_FLAG,
  CAN_ERR_FLAG,
  CAN_RTR_FLAG,
  CanFrame,
  GS_CAN_FLAG_FD,
  GS_HOST_FRAME_ECHO_ID_RX,
  TransportError,
  calculateBitTiming,
  decodeHostFrame,
  encodeBitTiming,
  encodeHostFormat,
  encodeHostFrame,
  encodeMode,
  parseBitTimingConstants,
  parseDeviceConfig,
  type GsBitTimingConstants,
} from "../src/core/index.js";

const le32 = (...words: number[]): Uint8Array => {
  const data = new Uint8Array(words.length * 4);
  const view = new DataView(data.buffer);
  words.forEach((word, index) => {
    view.setUint32(index * 4, word, true);
  });
  return data;
};

/** A 48 MHz controller with the segment limits of a bxCAN-style device. */
const CONSTANTS: GsBitTimingConstants = {
  features: 1,
  clockHz: 48_000_000,
  tseg1Min: 1,
  tseg1Max: 16,
  tseg2Min: 1,
  tseg2Max: 8,
  sjwMax: 4,
  brpMin: 1,
  brpMax: 1024,
  brpInc: 1,
};

const CONSTANTS_REPLY = le32(1, 48_000_000, 1, 16, 1, 8, 4, 1, 1024, 1);

/** The host frame bytes the adapter sends, built field by field so the decoder is checked against the layout. */
function hostFrame(
  echoId: number,
  canId: number,
  data: readonly number[],
  options: { channel?: number; flags?: number; dlc?: number } = {},
): Uint8Array {
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  view.setUint32(0, echoId, true);
  view.setUint32(4, canId >>> 0, true);
  out[8] = options.dlc ?? data.length;
  out[9] = options.channel ?? 0;
  out[10] = options.flags ?? 0;
  out.set(data, 12);
  return out;
}

describe("gs_usb control data", () => {
  it("selects little-endian data with the 0xbeef handshake", () => {
    expect(encodeHostFormat()).toEqual(Uint8Array.of(0xef, 0xbe, 0x00, 0x00));
  });

  it("starts and stops a channel with the mode flags", () => {
    expect(encodeMode(true, 1)).toEqual(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0));
    expect(encodeMode(false, 0)).toEqual(new Uint8Array(8));
  });

  it("writes the five bit-timing words in the driver's order", () => {
    const timing = {
      propSeg: 6,
      phaseSeg1: 7,
      phaseSeg2: 2,
      sjw: 1,
      brp: 6,
      samplePoint: 875,
      bitrate: 500_000,
    };
    expect(encodeBitTiming(timing)).toEqual(le32(6, 7, 2, 1, 6));
  });

  it("reads the device configuration", () => {
    const reply = new Uint8Array(12);
    reply[3] = 1;
    reply.set(le32(0x01020304, 0x0a0b0c0d), 4);
    expect(parseDeviceConfig(reply)).toEqual({
      channels: 2,
      softwareVersion: 0x01020304,
      hardwareVersion: 0x0a0b0c0d,
    });
    expect(() => parseDeviceConfig(new Uint8Array(11))).toThrow(TransportError);
  });

  it("reads the bit-timing constants", () => {
    expect(parseBitTimingConstants(CONSTANTS_REPLY)).toEqual(CONSTANTS);
    expect(() => parseBitTimingConstants(CONSTANTS_REPLY.slice(0, 39))).toThrow(TransportError);
    expect(() => parseBitTimingConstants(le32(1, 0, 1, 16, 1, 8, 4, 1, 1024, 1))).toThrow(
      /cannot be used/,
    );
    expect(() => parseBitTimingConstants(le32(1, 48_000_000, 1, 16, 1, 8, 4, 1, 1024, 0))).toThrow(
      /cannot be used/,
    );
  });
});

describe("bit timing", () => {
  it("gives 500 kbit/s 16 quanta sampled at 87.5%", () => {
    expect(calculateBitTiming(CONSTANTS, 500_000)).toEqual({
      propSeg: 6,
      phaseSeg1: 7,
      phaseSeg2: 2,
      sjw: 1,
      brp: 6,
      samplePoint: 875,
      bitrate: 500_000,
    });
  });

  it("scales only the prescaler for a slower rate", () => {
    expect(calculateBitTiming(CONSTANTS, 125_000)).toMatchObject({ brp: 24, phaseSeg2: 2 });
  });

  it("samples at 75% above 800 kbit/s", () => {
    expect(calculateBitTiming(CONSTANTS, 1_000_000)).toEqual({
      propSeg: 5,
      phaseSeg1: 6,
      phaseSeg2: 4,
      sjw: 2,
      brp: 3,
      samplePoint: 750,
      bitrate: 1_000_000,
    });
  });

  it("keeps the jump width within the device's limit", () => {
    expect(calculateBitTiming({ ...CONSTANTS, sjwMax: 1 }, 1_000_000).sjw).toBe(1);
  });

  it("always chooses a timing the limits allow", () => {
    for (const bitrate of [
      10_000, 20_000, 50_000, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000,
    ]) {
      const timing = calculateBitTiming(CONSTANTS, bitrate);
      const quanta = 1 + timing.propSeg + timing.phaseSeg1 + timing.phaseSeg2;
      expect(timing.phaseSeg1 + timing.propSeg).toBeGreaterThanOrEqual(CONSTANTS.tseg1Min);
      expect(timing.phaseSeg1 + timing.propSeg).toBeLessThanOrEqual(CONSTANTS.tseg1Max);
      expect(timing.phaseSeg2).toBeGreaterThanOrEqual(CONSTANTS.tseg2Min);
      expect(timing.phaseSeg2).toBeLessThanOrEqual(CONSTANTS.tseg2Max);
      expect(timing.brp).toBeLessThanOrEqual(CONSTANTS.brpMax);
      expect(CONSTANTS.clockHz / (timing.brp * quanta)).toBe(timing.bitrate);
      expect(timing.bitrate).toBe(bitrate);
    }
  });

  it("accepts a rate within 5% and reports the rate it gives", () => {
    const timing = calculateBitTiming({ ...CONSTANTS, brpMax: 1 }, 1_900_000);
    expect(timing.bitrate).not.toBe(1_900_000);
    expect(Math.abs(timing.bitrate - 1_900_000) / 1_900_000).toBeLessThan(0.05);
  });

  it("refuses a rate more than 5% away and a rate with no prescaler", () => {
    expect(() => calculateBitTiming({ ...CONSTANTS, brpMax: 1 }, 1_700_000)).toThrow(/% from/);
    expect(() => calculateBitTiming({ ...CONSTANTS, brpMax: 1 }, 100_000)).toThrow(/no bit timing/);
  });

  it.each([0, -1, 500.5, Number.NaN])("refuses %s as a rate", (bitrate) => {
    expect(() => calculateBitTiming(CONSTANTS, bitrate)).toThrow(TransportError);
  });
});

describe("host frames", () => {
  it("encodes a standard frame", () => {
    expect(encodeHostFrame(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)), 0, 3, false)).toEqual(
      Uint8Array.of(3, 0, 0, 0, 0xe0, 0x07, 0, 0, 3, 0, 0, 0, 2, 0x10, 0x92, 0, 0, 0, 0, 0),
    );
  });

  it("marks an extended identifier, names the channel and pads for the LPC546XX quirk", () => {
    const encoded = encodeHostFrame(
      new CanFrame(0x18da10f1, Uint8Array.of(0xaa), true),
      1,
      9,
      true,
    );
    expect(encoded).toHaveLength(21);
    expect([...encoded.slice(0, 12)]).toEqual([9, 0, 0, 0, 0xf1, 0x10, 0xda, 0x98, 1, 1, 0, 0]);
    expect(encoded[12]).toBe(0xaa);
    expect(encoded[20]).toBe(0);
    expect(CAN_EFF_FLAG).toBe(0x80000000);
  });

  it("decodes a received frame", () => {
    expect(decodeHostFrame(hostFrame(GS_HOST_FRAME_ECHO_ID_RX, 0x7e8, [0x50, 0x92]))).toEqual({
      kind: "rx",
      channel: 0,
      frame: new CanFrame(0x7e8, Uint8Array.of(0x50, 0x92)),
    });
    expect(
      decodeHostFrame(
        hostFrame(GS_HOST_FRAME_ECHO_ID_RX, CAN_EFF_FLAG | 0x18daf110, [], { channel: 1 }),
      ),
    ).toEqual({ kind: "rx", channel: 1, frame: new CanFrame(0x18daf110, new Uint8Array(0), true) });
  });

  it("treats the echo of a transmitted frame as an echo", () => {
    expect(decodeHostFrame(hostFrame(4, 0x7e0, [2, 0x10, 0x92]))).toEqual({
      kind: "echo",
      channel: 0,
      echoId: 4,
    });
  });

  it("ignores remote, error and CAN FD frames", () => {
    for (const packet of [
      hostFrame(GS_HOST_FRAME_ECHO_ID_RX, CAN_RTR_FLAG | 0x123, [], { dlc: 4 }),
      hostFrame(GS_HOST_FRAME_ECHO_ID_RX, CAN_ERR_FLAG | 0x4, [0, 1, 0, 0, 0, 0, 0, 0], { dlc: 8 }),
      hostFrame(GS_HOST_FRAME_ECHO_ID_RX, 0x123, [1], { flags: GS_CAN_FLAG_FD }),
    ]) {
      expect(decodeHostFrame(packet)).toEqual({ kind: "ignored" });
    }
  });

  it("reads a length code above eight as eight, and refuses a truncated packet", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(decodeHostFrame(hostFrame(GS_HOST_FRAME_ECHO_ID_RX, 0x100, data, { dlc: 15 }))).toEqual({
      kind: "rx",
      channel: 0,
      frame: new CanFrame(0x100, Uint8Array.from(data)),
    });
    expect(() => decodeHostFrame(new Uint8Array(11))).toThrow(TransportError);
    expect(() =>
      decodeHostFrame(hostFrame(GS_HOST_FRAME_ECHO_ID_RX, 0x100, data).slice(0, 15)),
    ).toThrow(/declares 8 data bytes/);
  });
});
