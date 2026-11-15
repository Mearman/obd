/**
 * Raw CAN over WebUSB for adapters that run gs_usb firmware (candleLight, CANable, and the other
 * families the Linux `gs_usb` driver binds to). This is how such an adapter works in a browser, and
 * on macOS, where there is no SocketCAN.
 *
 * The protocol is in `core/gsusb.ts`, which cites its sources; the sequence here follows the Linux
 * driver's `gs_usb_probe` (host format, device configuration, endpoints) and `gs_can_open` (bit
 * timing, then start). The WebUSB surface is the WICG/WHATWG specification, https://usb.spec.whatwg.org/
 * (read for this port; `USB.requestDevice`, `USBDevice`, `USBInTransferResult` and the `disconnect`
 * event on `navigator.usb`).
 */

import type { CanFrame, CanLink } from "../core/can.js";
import { FrameQueue } from "../core/framequeue.js";
import {
  GS_BT_CONST_SIZE,
  GS_CAN_FEATURE_LISTEN_ONLY,
  GS_CAN_FEATURE_REQ_USB_QUIRK_LPC546XX,
  GS_CAN_MODE_LISTEN_ONLY,
  GS_DEVICE_CONFIG_SIZE,
  GS_USB_BREQ,
  GS_USB_DEVICE_IDS,
  calculateBitTiming,
  decodeHostFrame,
  encodeBitTiming,
  encodeHostFormat,
  encodeHostFrame,
  encodeMode,
  parseBitTimingConstants,
  parseDeviceConfig,
  type GsBitTimingConstants,
} from "../core/gsusb.js";
import { RawCanTransport } from "../core/rawcan.js";
import { AdapterUrlError, TransportError, type AdapterAddress } from "../core/transport.js";
import { parseInteger } from "./params.js";

/** The part of a USB endpoint descriptor the link reads. */
export interface UsbEndpointLike {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
}

/** The part of a USB interface's active alternate setting the link reads. */
export interface UsbAlternateLike {
  readonly endpoints: readonly UsbEndpointLike[];
}

/** The part of a USB interface the link reads. */
export interface UsbInterfaceLike {
  readonly interfaceNumber: number;
  readonly alternate: UsbAlternateLike;
}

/** The part of a USB configuration the link reads. */
export interface UsbConfigurationLike {
  readonly configurationValue: number;
  readonly interfaces: readonly UsbInterfaceLike[];
}

/** The setup packet of a vendor request to an interface, the only kind gs_usb uses. */
export interface UsbSetupLike {
  readonly requestType: "vendor";
  readonly recipient: "interface";
  readonly request: number;
  readonly value: number;
  readonly index: number;
}

/** The result of a transfer from the device. */
export interface UsbInResultLike {
  readonly status: "ok" | "stall" | "babble";
  readonly data?: DataView | undefined;
}

/** The result of a transfer to the device. */
export interface UsbOutResultLike {
  readonly status: "ok" | "stall" | "babble";
  readonly bytesWritten: number;
}

/** The part of a `USBDevice` the link uses. A real `USBDevice` satisfies it. */
export interface UsbDeviceLike {
  readonly configuration: UsbConfigurationLike | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(setup: UsbSetupLike, length: number): Promise<UsbInResultLike>;
  controlTransferOut(setup: UsbSetupLike, data: Uint8Array<ArrayBuffer>): Promise<UsbOutResultLike>;
  clearHalt(direction: "in" | "out", endpointNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<UsbInResultLike>;
  transferOut(endpointNumber: number, data: Uint8Array<ArrayBuffer>): Promise<UsbOutResultLike>;
}

/** What `requestDevice` is asked for: the picker's filters. */
export interface UsbRequest {
  readonly filters: { vendorId?: number; productId?: number }[];
}

/** The part of `navigator.usb` the link uses. */
export interface UsbLike {
  requestDevice(options: UsbRequest): Promise<UsbDeviceLike>;
  addEventListener(type: "disconnect", listener: (event: Event) => void): void;
  removeEventListener(type: "disconnect", listener: (event: Event) => void): void;
}

/** The environment a WebUSB link reads its `USB` object from. */
export interface UsbEnvironment {
  /** `navigator.usb`, or undefined where the browser has no WebUSB. */
  readonly usb: UsbLike | undefined;
}

/** The environment of the running page. */
export function browserUsbEnvironment(): UsbEnvironment {
  if (typeof navigator === "undefined" || !("usb" in navigator)) return { usb: undefined };
  const usb: UsbLike = navigator.usb;
  return { usb };
}

/** Bytes asked of each bulk-in transfer: above the largest classic frame (24 with a timestamp), within a full-speed packet. */
const RX_TRANSFER_LENGTH = 64;

/** The configuration a gs_usb adapter has: the driver selects its only one. */
const CONFIGURATION_VALUE = 1;

/** `wValue` of the host-format and device-configuration requests (the driver passes 1). */
const PROBE_VALUE = 1;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The picker filter an adapter URL asks for. Parameters: `usbVendorId` and `usbProductId` (decimal
 * or `0x` hex; a product needs its vendor). With none, the picker lists every adapter family the
 * Linux gs_usb driver binds to.
 *
 * @throws AdapterUrlError for a value that is not a number, or a product without a vendor.
 */
export function usbRequestFromParams(params: ReadonlyMap<string, string>): UsbRequest {
  const vendor = params.get("usbVendorId");
  const product = params.get("usbProductId");
  if (vendor === undefined) {
    if (product !== undefined) {
      throw new AdapterUrlError("usbProductId needs usbVendorId: a USB product id is per vendor");
    }
    return { filters: GS_USB_DEVICE_IDS.map((id) => ({ ...id })) };
  }
  const filter: { vendorId: number; productId?: number } = {
    vendorId: parseInteger("usbVendorId", vendor),
  };
  if (product !== undefined) filter.productId = parseInteger("usbProductId", product);
  return { filters: [filter] };
}

/** The first bulk-in and bulk-out endpoints of a configuration's interface, as `usb_find_common_endpoints` finds them. */
function findBulkInterface(
  configuration: UsbConfigurationLike,
): { interfaceNumber: number; inEndpoint: number; outEndpoint: number } | undefined {
  for (const usbInterface of configuration.interfaces) {
    const bulk = usbInterface.alternate.endpoints.filter((endpoint) => endpoint.type === "bulk");
    const input = bulk.find((endpoint) => endpoint.direction === "in");
    const output = bulk.find((endpoint) => endpoint.direction === "out");
    if (input !== undefined && output !== undefined) {
      return {
        interfaceNumber: usbInterface.interfaceNumber,
        inEndpoint: input.endpointNumber,
        outEndpoint: output.endpointNumber,
      };
    }
  }
  return undefined;
}

function bytesOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function disconnectedDevice(event: Event): unknown {
  return "device" in event ? event.device : undefined;
}

/**
 * One CAN channel of a gs_usb adapter reached over WebUSB.
 *
 * {@link open} shows the browser's device picker, so it must be called straight from a user gesture
 * (a click handler) with nothing awaited before it. It claims the adapter and reads its
 * configuration; {@link configure} chooses the bit timing and starts the channel.
 */
export class WebUsbCanLink implements CanLink {
  readonly #label: string;
  readonly #request: UsbRequest;
  readonly #channel: number;
  readonly #environment: UsbEnvironment;
  #queue = new FrameQueue();
  #device: UsbDeviceLike | undefined;
  #usb: UsbLike | undefined;
  #interfaceNumber = 0;
  #inEndpoint = 0;
  #outEndpoint = 0;
  #constants: GsBitTimingConstants | undefined;
  #started = false;
  #loop: Promise<void> | undefined;
  #closing = false;
  #disconnected = false;
  #echoId = 0;
  #onDisconnect: ((event: Event) => void) | undefined;

  /**
   * @param label Free name for the adapter, used in messages.
   * @param request Picker filters, usually from {@link usbRequestFromParams}.
   * @param channel Which of the adapter's CAN channels to use, counting from 0.
   * @param environment Where to find `navigator.usb`.
   */
  constructor(
    label: string,
    request: UsbRequest,
    channel = 0,
    environment: UsbEnvironment = browserUsbEnvironment(),
  ) {
    this.#label = label;
    this.#request = request;
    this.#channel = channel;
    this.#environment = environment;
  }

  /**
   * Shows the device picker, opens and claims the chosen adapter, and reads its configuration and
   * the bit-timing limits of the channel. Nothing is put on the bus.
   *
   * @throws TransportError when WebUSB is missing, permission is denied, no device is chosen, the
   * adapter has no bulk endpoint pair or no such channel, or any setup request fails.
   */
  async open(): Promise<void> {
    if (this.#device !== undefined) return;
    const usb = this.#environment.usb;
    if (usb === undefined) {
      throw new TransportError(
        "WebUSB is not available in this browser (it needs Chrome or Edge over HTTPS or localhost)",
      );
    }
    let device: UsbDeviceLike;
    try {
      device = await usb.requestDevice(this.#request);
    } catch (error) {
      const name = errorName(error);
      if (name === "NotFoundError") {
        throw new TransportError(`no USB device was chosen for ${this.#label}`, { cause: error });
      }
      if (name === "SecurityError" || name === "NotAllowedError") {
        throw new TransportError(
          `permission to use a USB device was denied (it must be requested from a click or tap): ${errorText(error)}`,
          { cause: error },
        );
      }
      throw new TransportError(`cannot request a USB device: ${errorText(error)}`, {
        cause: error,
      });
    }
    this.#queue = new FrameQueue();
    this.#closing = false;
    this.#disconnected = false;
    this.#started = false;
    this.#device = device;
    this.#usb = usb;
    this.#onDisconnect = (event) => {
      if (disconnectedDevice(event) !== device) return;
      this.#disconnected = true;
      this.#queue.fail(new TransportError(`the USB adapter ${this.#label} was disconnected`));
    };
    usb.addEventListener("disconnect", this.#onDisconnect);
    let claimed: number | undefined;
    try {
      await device.open();
      if (device.configuration === null) await device.selectConfiguration(CONFIGURATION_VALUE);
      const configuration = device.configuration;
      if (configuration === null) throw new TransportError("the USB adapter has no configuration");
      const endpoints = findBulkInterface(configuration);
      if (endpoints === undefined) {
        throw new TransportError(
          "the USB device has no bulk endpoint pair: it is not a gs_usb adapter",
        );
      }
      this.#interfaceNumber = endpoints.interfaceNumber;
      this.#inEndpoint = endpoints.inEndpoint;
      this.#outEndpoint = endpoints.outEndpoint;
      await device.claimInterface(this.#interfaceNumber);
      claimed = this.#interfaceNumber;
      await this.#controlOut(
        GS_USB_BREQ.hostFormat,
        PROBE_VALUE,
        this.#interfaceNumber,
        encodeHostFormat(),
      );
      const config = parseDeviceConfig(
        await this.#controlIn(
          GS_USB_BREQ.deviceConfig,
          PROBE_VALUE,
          this.#interfaceNumber,
          GS_DEVICE_CONFIG_SIZE,
        ),
      );
      if (this.#channel >= config.channels) {
        throw new TransportError(
          `the USB adapter has ${String(config.channels)} CAN channel(s), so channel ${String(this.#channel)} does not exist`,
        );
      }
      this.#constants = parseBitTimingConstants(
        await this.#controlIn(GS_USB_BREQ.btConst, this.#channel, 0, GS_BT_CONST_SIZE),
      );
    } catch (error) {
      await this.#release(device, claimed);
      throw error instanceof TransportError
        ? error
        : new TransportError(`cannot open the USB adapter ${this.#label}: ${errorText(error)}`, {
            cause: error,
          });
    }
  }

  /**
   * Chooses the bit timing for `bitrate`, then starts the channel, listen-only when asked.
   * Reconfiguring a started channel stops it first.
   *
   * @throws TransportError when the link is not open, the adapter cannot make the rate within 5%,
   * the adapter cannot listen only, or a request fails.
   */
  async configure(bitrate: number, listenOnly: boolean): Promise<void> {
    const device = this.#device;
    const constants = this.#constants;
    if (device === undefined || constants === undefined) {
      throw new TransportError("the USB link is not open");
    }
    const timing = calculateBitTiming(constants, bitrate);
    if (listenOnly && (constants.features & GS_CAN_FEATURE_LISTEN_ONLY) === 0) {
      throw new TransportError("the USB adapter cannot start a channel listen-only");
    }
    if (this.#started) {
      await this.#controlOut(GS_USB_BREQ.mode, this.#channel, 0, encodeMode(false, 0));
      this.#started = false;
    }
    await this.#controlOut(GS_USB_BREQ.bitTiming, this.#channel, 0, encodeBitTiming(timing));
    // Receiving starts before the channel does, as the driver submits its read requests first.
    this.#loop ??= this.#readLoop(device);
    await this.#controlOut(
      GS_USB_BREQ.mode,
      this.#channel,
      0,
      encodeMode(true, listenOnly ? GS_CAN_MODE_LISTEN_ONLY : 0),
    );
    this.#started = true;
  }

  async #controlOut(
    request: number,
    value: number,
    index: number,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const device = this.#device;
    if (device === undefined) throw new TransportError("the USB link is not open");
    let result: UsbOutResultLike;
    try {
      result = await device.controlTransferOut(
        { requestType: "vendor", recipient: "interface", request, value, index },
        data,
      );
    } catch (error) {
      throw this.#failure(`USB request ${String(request)} failed`, error);
    }
    if (result.status !== "ok") {
      throw new TransportError(`USB request ${String(request)} was refused (${result.status})`);
    }
  }

  async #controlIn(
    request: number,
    value: number,
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const device = this.#device;
    if (device === undefined) throw new TransportError("the USB link is not open");
    let result: UsbInResultLike;
    try {
      result = await device.controlTransferIn(
        { requestType: "vendor", recipient: "interface", request, value, index },
        length,
      );
    } catch (error) {
      throw this.#failure(`USB request ${String(request)} failed`, error);
    }
    if (result.status !== "ok" || result.data === undefined) {
      throw new TransportError(`USB request ${String(request)} was refused (${result.status})`);
    }
    return bytesOf(result.data);
  }

  #failure(action: string, error: unknown): TransportError {
    return new TransportError(
      this.#disconnected
        ? `the USB adapter ${this.#label} was disconnected`
        : `${action}: ${errorText(error)}`,
      { cause: error },
    );
  }

  async #readLoop(device: UsbDeviceLike): Promise<void> {
    try {
      while (!this.#closing) {
        const result = await device.transferIn(this.#inEndpoint, RX_TRANSFER_LENGTH);
        if (result.status === "stall") {
          await device.clearHalt("in", this.#inEndpoint);
          continue;
        }
        if (result.status === "babble") {
          throw new TransportError("the USB adapter sent more than a frame in one transfer");
        }
        if (result.data === undefined || result.data.byteLength === 0) continue;
        const decoded = decodeHostFrame(bytesOf(result.data));
        if (decoded.kind === "rx" && decoded.channel === this.#channel) {
          this.#queue.push(decoded.frame);
        }
      }
    } catch (error) {
      if (!this.#closing) {
        this.#queue.fail(
          error instanceof TransportError && !this.#disconnected
            ? error
            : this.#failure("reading the USB adapter failed", error),
        );
      }
    }
  }

  /**
   * Stops the channel, releases the adapter and closes it. Safe to call when it never opened and
   * repeatedly.
   *
   * @throws TransportError when stopping the channel fails; the adapter is released regardless.
   */
  async close(): Promise<void> {
    const device = this.#device;
    if (device === undefined) return;
    this.#device = undefined;
    this.#closing = true;
    this.#queue.close();
    const wasStarted = this.#started;
    this.#started = false;
    try {
      if (wasStarted && !this.#disconnected) {
        try {
          await device.controlTransferOut(
            {
              requestType: "vendor",
              recipient: "interface",
              request: GS_USB_BREQ.mode,
              value: this.#channel,
              index: 0,
            },
            encodeMode(false, 0),
          );
        } catch (error) {
          throw new TransportError(`cannot stop the USB channel: ${errorText(error)}`, {
            cause: error,
          });
        }
      }
    } finally {
      await this.#release(device, this.#disconnected ? undefined : this.#interfaceNumber);
      await this.#loop;
      this.#loop = undefined;
    }
  }

  /** Releases the claimed interface, if any, and closes the device. */
  async #release(device: UsbDeviceLike, claimed: number | undefined): Promise<void> {
    if (this.#usb !== undefined && this.#onDisconnect !== undefined) {
      this.#usb.removeEventListener("disconnect", this.#onDisconnect);
      this.#onDisconnect = undefined;
    }
    if (this.#device === device) this.#device = undefined;
    try {
      if (claimed !== undefined) await device.releaseInterface(claimed);
    } finally {
      // A device that was unplugged can no longer be closed cleanly, and is gone either way.
      if (this.#disconnected) await device.close().catch(() => undefined);
      else await device.close();
    }
  }

  /**
   * Puts one frame on the bus.
   *
   * @throws TransportError when the channel is not started, the adapter was unplugged or the
   * transfer fails.
   */
  async send(frame: CanFrame): Promise<void> {
    const device = this.#device;
    const constants = this.#constants;
    if (device === undefined || constants === undefined || !this.#started) {
      throw new TransportError("the USB channel is not started");
    }
    if (this.#disconnected) {
      throw new TransportError(`the USB adapter ${this.#label} was disconnected`);
    }
    const quirk = (constants.features & GS_CAN_FEATURE_REQ_USB_QUIRK_LPC546XX) !== 0;
    // The adapter echoes this identifier when the frame is on the bus; any value but all ones will do.
    this.#echoId = (this.#echoId + 1) % 0x7fffffff;
    const packet = encodeHostFrame(frame, this.#channel, this.#echoId, quirk);
    let result: UsbOutResultLike;
    try {
      result = await device.transferOut(this.#outEndpoint, packet);
    } catch (error) {
      throw this.#failure("sending on the USB adapter failed", error);
    }
    if (result.status !== "ok" || result.bytesWritten !== packet.length) {
      throw new TransportError(`the USB adapter refused the frame (${result.status})`);
    }
  }

  /**
   * Returns the next data frame on the bus.
   *
   * @throws TransportTimeout when none arrives within `timeoutMs`.
   * @throws TransportError when the adapter was unplugged or the link failed.
   */
  receive(timeoutMs: number): Promise<CanFrame> {
    return this.#queue.receive(timeoutMs);
  }
}

/**
 * Builds the `webusb` transport for an adapter URL: an ELM327 look-alike over a gs_usb adapter. The
 * target is only a label; `channel` picks the adapter's CAN channel (default 0) and the picker
 * filters come from {@link usbRequestFromParams}.
 *
 * @throws AdapterUrlError for an invalid `channel` or filter parameter.
 */
export function createWebUsbTransport(
  address: AdapterAddress,
  environment: UsbEnvironment = browserUsbEnvironment(),
): RawCanTransport {
  const channel = address.params.get("channel");
  const link = new WebUsbCanLink(
    address.target,
    usbRequestFromParams(address.params),
    channel === undefined ? 0 : parseInteger("channel", channel),
    environment,
  );
  return new RawCanTransport(link, `webusb ${address.target}`);
}
