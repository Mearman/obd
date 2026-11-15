/**
 * The gs_usb protocol of candleLight, CANable and Geschwister Schneider USB/CAN adapters: the
 * control requests that configure a channel, the bit-timing calculation, and the 20-byte host
 * frame that carries a classic CAN frame over the bulk endpoints. Platform-free: moving the bytes
 * is the job of a USB binding (`obd-read/web` uses WebUSB).
 *
 * Sources, read in full for this port:
 * - the Linux driver, https://github.com/torvalds/linux/blob/master/drivers/net/can/usb/gs_usb.c
 *   (snapshot https://web.archive.org/web/20260823222353/https://github.com/torvalds/linux/blob/master/drivers/net/can/usb/gs_usb.c)
 *   for the request numbers, the structure layouts, the probe and open sequences and the host frame;
 * - the candleLight firmware header, https://github.com/candle-usb/candleLight_fw/blob/master/include/gs_usb.h,
 *   for the same layouts as the firmware defines them, and the little-endian byte order;
 * - the kernel's bit-timing calculation,
 *   https://github.com/torvalds/linux/blob/master/drivers/net/can/dev/calc_bittiming.c and
 *   https://github.com/torvalds/linux/blob/master/drivers/net/can/dev/bittiming.c, which the
 *   firmware's host driver runs and which this module reproduces so a bit rate gets the same
 *   timing here as it does under SocketCAN.
 *
 * Every multi-byte field is little endian: the candleLight firmware does not honour the byte-order
 * handshake, and the original Geschwister Schneider firmware is told to use little endian by it.
 */

import { CanFrame, MAX_DATA } from "./can.js";
import { TransportError } from "./transport.js";

/** `bRequest` values of the vendor control requests (`enum gs_usb_breq`). */
export const GS_USB_BREQ = {
  hostFormat: 0,
  bitTiming: 1,
  mode: 2,
  btConst: 4,
  deviceConfig: 5,
} as const;

/** `mode` field of {@link encodeMode} (`enum gs_can_mode`). */
export const GS_CAN_MODE = { reset: 0, start: 1 } as const;

/** Bit of {@link GsBitTimingConstants.features} that says the channel can be started listen-only. */
export const GS_CAN_FEATURE_LISTEN_ONLY = 1 << 0;

/**
 * Bit of {@link GsBitTimingConstants.features} that says the device needs one padding byte after
 * every host frame (a workaround for erratum USB.15 of the LPC546XX).
 */
export const GS_CAN_FEATURE_REQ_USB_QUIRK_LPC546XX = 1 << 9;

/** Bit of the mode flags that starts the channel without driving the bus. */
export const GS_CAN_MODE_LISTEN_ONLY = 1 << 0;

/** Value of the host-format handshake word that selects little-endian data. */
export const GS_HOST_BYTE_ORDER = 0x0000beef;

/** Bytes in the reply to {@link GS_USB_BREQ.deviceConfig}. */
export const GS_DEVICE_CONFIG_SIZE = 12;

/** Bytes in the reply to {@link GS_USB_BREQ.btConst}. */
export const GS_BT_CONST_SIZE = 40;

/** Bytes in a host frame header: echo identifier, CAN identifier, length, channel, flags, reserved. */
export const GS_HOST_FRAME_HEADER_SIZE = 12;

/** `echo_id` of a frame received from the bus, as opposed to the echo of a transmitted frame. */
export const GS_HOST_FRAME_ECHO_ID_RX = 0xffffffff;

/** `can_id` bit that marks a 29-bit identifier. */
export const CAN_EFF_FLAG = 0x80000000;

/** `can_id` bit that marks a remote transmission request, which carries no data. */
export const CAN_RTR_FLAG = 0x40000000;

/** `can_id` bit that marks an error frame, whose data describes the controller, not the bus. */
export const CAN_ERR_FLAG = 0x20000000;

/** `flags` bit of a host frame that marks a CAN FD frame. */
export const GS_CAN_FLAG_FD = 1 << 1;

/** Vendor and product of each adapter family the Linux driver binds to (its `gs_usb_table`). */
export const GS_USB_DEVICE_IDS: readonly {
  readonly vendorId: number;
  readonly productId: number;
}[] = [
  { vendorId: 0x1d50, productId: 0x606f },
  { vendorId: 0x1209, productId: 0x2323 },
  { vendorId: 0x1cd2, productId: 0x606f },
  { vendorId: 0x16d0, productId: 0x10b8 },
  { vendorId: 0x16d0, productId: 0x0f30 },
  { vendorId: 0x1209, productId: 0xca01 },
];

const CAN_EFF_MASK = 0x1fffffff;
const CAN_SFF_MASK = 0x7ff;

// Kernel `can_calc_bittiming`: the synchronisation segment is one time quantum, and a rate whose
// best timing is more than 5% off is refused.
const SYNC_SEG = 1;
const MAX_BITRATE_ERROR_HUNDREDTHS = 500;

/** What `GS_USB_BREQ.deviceConfig` reports. */
export interface GsDeviceConfig {
  /** CAN channels the adapter has; channel numbers run from 0. */
  readonly channels: number;
  readonly softwareVersion: number;
  readonly hardwareVersion: number;
}

/** What `GS_USB_BREQ.btConst` reports for one channel: its features and bit-timing limits. */
export interface GsBitTimingConstants {
  /** `GS_CAN_FEATURE_*` bits. */
  readonly features: number;
  /** CAN controller clock in hertz. */
  readonly clockHz: number;
  readonly tseg1Min: number;
  readonly tseg1Max: number;
  readonly tseg2Min: number;
  readonly tseg2Max: number;
  readonly sjwMax: number;
  readonly brpMin: number;
  readonly brpMax: number;
  readonly brpInc: number;
}

/** The segments of one bit, in time quanta, and the prescaler that sets the quantum. */
export interface GsBitTiming {
  readonly propSeg: number;
  readonly phaseSeg1: number;
  readonly phaseSeg2: number;
  readonly sjw: number;
  readonly brp: number;
  /** Sample point in tenths of a percent of the bit, as the kernel reports it. */
  readonly samplePoint: number;
  /** The bit rate this timing gives, which can differ slightly from the one asked for. */
  readonly bitrate: number;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Reads the reply to the device-configuration request: three reserved bytes, the highest channel
 * index, then the software and hardware versions.
 *
 * @throws TransportError when the reply is shorter than {@link GS_DEVICE_CONFIG_SIZE}.
 */
export function parseDeviceConfig(data: Uint8Array): GsDeviceConfig {
  if (data.length < GS_DEVICE_CONFIG_SIZE) {
    throw new TransportError(
      `the gs_usb device configuration is ${String(data.length)} bytes, expected ${String(GS_DEVICE_CONFIG_SIZE)}`,
    );
  }
  const fields = view(data);
  return {
    channels: fields.getUint8(3) + 1,
    softwareVersion: fields.getUint32(4, true),
    hardwareVersion: fields.getUint32(8, true),
  };
}

/**
 * Reads the reply to the bit-timing-constants request.
 *
 * @throws TransportError when the reply is short, or a limit would make a timing impossible (a
 * zero clock, a zero prescaler step or minimum).
 */
export function parseBitTimingConstants(data: Uint8Array): GsBitTimingConstants {
  if (data.length < GS_BT_CONST_SIZE) {
    throw new TransportError(
      `the gs_usb bit-timing constants are ${String(data.length)} bytes, expected ${String(GS_BT_CONST_SIZE)}`,
    );
  }
  const fields = view(data);
  const word = (index: number): number => fields.getUint32(index * 4, true);
  const constants: GsBitTimingConstants = {
    features: word(0),
    clockHz: word(1),
    tseg1Min: word(2),
    tseg1Max: word(3),
    tseg2Min: word(4),
    tseg2Max: word(5),
    sjwMax: word(6),
    brpMin: word(7),
    brpMax: word(8),
    brpInc: word(9),
  };
  if (
    constants.clockHz === 0 ||
    constants.brpMin === 0 ||
    constants.brpInc === 0 ||
    constants.sjwMax === 0
  ) {
    throw new TransportError("the gs_usb adapter reported bit-timing limits that cannot be used");
  }
  return constants;
}

/** The data of the host-format request that selects little-endian data. */
export function encodeHostFormat(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(4);
  view(data).setUint32(0, GS_HOST_BYTE_ORDER, true);
  return data;
}

/**
 * The data of a mode request: stops the channel, or starts it with the given `GS_CAN_MODE_*` flags.
 * Hardware timestamps, CAN FD and every other mode flag stay off.
 */
export function encodeMode(start: boolean, flags: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(8);
  const fields = view(data);
  fields.setUint32(0, start ? GS_CAN_MODE.start : GS_CAN_MODE.reset, true);
  fields.setUint32(4, flags, true);
  return data;
}

/** The data of a bit-timing request. */
export function encodeBitTiming(timing: GsBitTiming): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(20);
  const fields = view(data);
  fields.setUint32(0, timing.propSeg, true);
  fields.setUint32(4, timing.phaseSeg1, true);
  fields.setUint32(8, timing.phaseSeg2, true);
  fields.setUint32(12, timing.sjw, true);
  fields.setUint32(16, timing.brp, true);
  return data;
}

/** CiA recommended sample points for non-return-to-zero coding, in tenths of a percent. */
function referenceSamplePoint(bitrate: number): number {
  if (bitrate > 800_000) return 750;
  if (bitrate > 500_000) return 800;
  return 875;
}

interface SegmentChoice {
  readonly tseg1: number;
  readonly tseg2: number;
  /** Distance of the sample point below the reference, or `Infinity` when none lies at or below it. */
  readonly error: number;
}

/** The kernel's `can_update_sample_point`: the split of `tseg` quanta that samples nearest below the reference. */
function chooseSegments(
  constants: GsBitTimingConstants,
  reference: number,
  tseg: number,
): SegmentChoice {
  let best: SegmentChoice = { tseg1: 0, tseg2: 0, error: Infinity };
  for (let i = 0; i <= 1; i++) {
    let tseg2 = tseg + SYNC_SEG - Math.floor((reference * (tseg + SYNC_SEG)) / 1000) - i;
    tseg2 = Math.min(Math.max(tseg2, constants.tseg2Min), constants.tseg2Max);
    let tseg1 = tseg - tseg2;
    if (tseg1 > constants.tseg1Max) {
      tseg1 = constants.tseg1Max;
      tseg2 = tseg - tseg1;
    }
    const samplePoint = Math.floor((1000 * (tseg + SYNC_SEG - tseg2)) / (tseg + SYNC_SEG));
    const error = Math.abs(reference - samplePoint);
    if (samplePoint <= reference && error < best.error) best = { tseg1, tseg2, error };
  }
  return best;
}

/**
 * Chooses the bit timing for `bitrate` on a channel with the given limits, by the kernel's
 * `can_calc_bittiming` search: the segment count and prescaler that give the nearest rate, then the
 * sample point nearest below the recommended one. The synchronisation jump width defaults to half
 * of phase segment 2, as in the kernel, but never above the device's limit.
 *
 * @throws TransportError when the rate is not a positive whole number, no prescaler fits, or the
 * nearest achievable rate is more than 5% from the one asked for.
 */
export function calculateBitTiming(constants: GsBitTimingConstants, bitrate: number): GsBitTiming {
  if (!Number.isInteger(bitrate) || bitrate <= 0) {
    throw new TransportError(`${String(bitrate)} is not a CAN bit rate`);
  }
  const reference = referenceSamplePoint(bitrate);
  let bestBitrateError = Infinity;
  let bestSamplePointError = Infinity;
  let bestTseg = 0;
  let bestBrp = 0;
  // `tseg` counts half time quanta, so the odd values round the prescaler up.
  for (
    let tseg = (constants.tseg1Max + constants.tseg2Max) * 2 + 1;
    tseg >= (constants.tseg1Min + constants.tseg2Min) * 2;
    tseg--
  ) {
    const quanta = SYNC_SEG + Math.floor(tseg / 2);
    let brp = Math.floor(constants.clockHz / (quanta * bitrate)) + (tseg % 2);
    brp = Math.floor(brp / constants.brpInc) * constants.brpInc;
    if (brp < constants.brpMin || brp > constants.brpMax) continue;
    const achieved = Math.floor(constants.clockHz / (brp * quanta));
    const bitrateError = Math.abs(bitrate - achieved);
    if (bitrateError > bestBitrateError) continue;
    if (bitrateError < bestBitrateError) bestSamplePointError = Infinity;
    const choice = chooseSegments(constants, reference, Math.floor(tseg / 2));
    if (choice.error >= bestSamplePointError) continue;
    bestSamplePointError = choice.error;
    bestBitrateError = bitrateError;
    bestTseg = Math.floor(tseg / 2);
    bestBrp = brp;
    if (bitrateError === 0 && choice.error === 0) break;
  }
  if (bestBrp === 0) {
    throw new TransportError(
      `the gs_usb adapter has no bit timing for ${String(bitrate)} bit/s with its ${String(constants.clockHz)} Hz clock`,
    );
  }
  if (bestBitrateError > 0) {
    const hundredths = Math.max(Math.floor((bestBitrateError * 10_000) / bitrate), 1);
    if (hundredths > MAX_BITRATE_ERROR_HUNDREDTHS) {
      throw new TransportError(
        `the nearest bit rate the gs_usb adapter can make is ${(hundredths / 100).toFixed(2)}% from ${String(bitrate)} bit/s`,
      );
    }
  }
  const { tseg1, tseg2 } = chooseSegments(constants, reference, bestTseg);
  const propSeg = Math.floor(tseg1 / 2);
  const phaseSeg1 = tseg1 - propSeg;
  const phaseSeg2 = tseg2;
  const sjw = Math.min(
    Math.max(1, Math.min(phaseSeg1, Math.floor(phaseSeg2 / 2))),
    constants.sjwMax,
  );
  return {
    propSeg,
    phaseSeg1,
    phaseSeg2,
    sjw,
    brp: bestBrp,
    samplePoint: Math.floor(
      (1000 * (SYNC_SEG + propSeg + phaseSeg1)) / (SYNC_SEG + propSeg + phaseSeg1 + phaseSeg2),
    ),
    bitrate: Math.floor(
      constants.clockHz / (bestBrp * (SYNC_SEG + propSeg + phaseSeg1 + phaseSeg2)),
    ),
  };
}

/** Bytes in a classic host frame: the header and eight data bytes. */
export const GS_HOST_FRAME_SIZE = GS_HOST_FRAME_HEADER_SIZE + MAX_DATA;

/**
 * The bulk-out packet that transmits `frame` on `channel`: the header, the data padded to eight
 * bytes, and one more byte when the adapter asks for the LPC546XX padding.
 *
 * @param echoId Returned in the echo the adapter sends once the frame is on the bus; it must not be
 * {@link GS_HOST_FRAME_ECHO_ID_RX}.
 */
export function encodeHostFrame(
  frame: CanFrame,
  channel: number,
  echoId: number,
  usbQuirkPadding: boolean,
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(GS_HOST_FRAME_SIZE + (usbQuirkPadding ? 1 : 0));
  const fields = view(data);
  fields.setUint32(0, echoId, true);
  fields.setUint32(4, (frame.canId | (frame.extended ? CAN_EFF_FLAG : 0)) >>> 0, true);
  fields.setUint8(8, frame.data.length);
  fields.setUint8(9, channel);
  data.set(frame.data, GS_HOST_FRAME_HEADER_SIZE);
  return data;
}

/** What one bulk-in packet carried. */
export type GsHostFrame =
  | { readonly kind: "rx"; readonly channel: number; readonly frame: CanFrame }
  | { readonly kind: "echo"; readonly channel: number; readonly echoId: number }
  | { readonly kind: "ignored" };

/**
 * Reads one bulk-in packet.
 *
 * A frame from the bus is `rx`; the adapter's confirmation that a transmitted frame went out is
 * `echo`; remote, error and CAN FD frames, which carry no classic data, are `ignored`. A receive
 * overflow flag is not reported: the frame it arrives on is delivered and the lost frames are not.
 *
 * @throws TransportError when the packet is shorter than its header, or than the data its length
 * code promises.
 */
export function decodeHostFrame(packet: Uint8Array): GsHostFrame {
  if (packet.length < GS_HOST_FRAME_HEADER_SIZE) {
    throw new TransportError(
      `a gs_usb packet is ${String(packet.length)} bytes, shorter than its ${String(GS_HOST_FRAME_HEADER_SIZE)}-byte header`,
    );
  }
  const fields = view(packet);
  const echoId = fields.getUint32(0, true);
  const canId = fields.getUint32(4, true);
  const length = Math.min(fields.getUint8(8), MAX_DATA);
  const channel = fields.getUint8(9);
  const flags = fields.getUint8(10);
  if (echoId !== GS_HOST_FRAME_ECHO_ID_RX) return { kind: "echo", channel, echoId };
  if ((canId & (CAN_RTR_FLAG | CAN_ERR_FLAG)) !== 0 || (flags & GS_CAN_FLAG_FD) !== 0) {
    return { kind: "ignored" };
  }
  if (packet.length < GS_HOST_FRAME_HEADER_SIZE + length) {
    throw new TransportError(
      `a gs_usb frame declares ${String(length)} data bytes but the packet is ${String(packet.length)} bytes`,
    );
  }
  const data = packet.slice(GS_HOST_FRAME_HEADER_SIZE, GS_HOST_FRAME_HEADER_SIZE + length);
  const extended = (canId & CAN_EFF_FLAG) !== 0;
  return {
    kind: "rx",
    channel,
    frame: new CanFrame(canId & (extended ? CAN_EFF_MASK : CAN_SFF_MASK), data, extended),
  };
}
