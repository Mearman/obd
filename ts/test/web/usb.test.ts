import { describe, expect, it } from "vitest";
import {
  AdapterUrlError,
  CanFrame,
  DiagProtocol,
  Elm,
  GS_USB_BREQ,
  RawCanTransport,
  TransportError,
  TransportTimeout,
  openTransport,
  parseAdapterUrl,
  permit,
} from "../../src/core/index.js";
import { WebUsbCanLink, createWebUsbTransport, usbRequestFromParams } from "../../src/web/usb.js";
import "../../src/web/index.js";
import {
  FakeUsb,
  FakeUsbDevice,
  le32,
  namedError,
  type FakeUsbOptions,
} from "../helpers/fake-usb.js";

const params = (url: string): ReadonlyMap<string, string> => parseAdapterUrl(url).params;
const REQUEST = usbRequestFromParams(new Map());

function rig(
  options: FakeUsbOptions = {},
  channel = 0,
): {
  device: FakeUsbDevice;
  usb: FakeUsb;
  link: WebUsbCanLink;
} {
  const device = new FakeUsbDevice(options);
  const usb = new FakeUsb(device);
  return { device, usb, link: new WebUsbCanLink("candle", REQUEST, channel, usb.environment) };
}

/** Lets the read loop's pending microtasks run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("opening the adapter", () => {
  it("probes it as the Linux driver does and puts nothing on the bus", async () => {
    const { device, usb, link } = rig();
    await link.open();
    expect(usb.requests[0]?.filters).toContainEqual({ vendorId: 0x1209, productId: 0x2323 });
    expect(device.log).toEqual([
      "open",
      "selectConfiguration 1",
      "claimInterface 0",
      "control out 0",
      "control in 5",
      "control in 4",
    ]);
    expect(device.controls.map((c) => [c.setup.request, c.setup.value, c.setup.index])).toEqual([
      [GS_USB_BREQ.hostFormat, 1, 0],
      [GS_USB_BREQ.deviceConfig, 1, 0],
      [GS_USB_BREQ.btConst, 0, 0],
    ]);
    expect(device.controls[0]?.data).toEqual(Uint8Array.of(0xef, 0xbe, 0, 0));
    expect(device.controls.map((c) => `${c.setup.requestType}/${c.setup.recipient}`)).toEqual([
      "vendor/interface",
      "vendor/interface",
      "vendor/interface",
    ]);
    expect(device.transmitted).toEqual([]);
  });

  it("is idempotent while open", async () => {
    const { device, link } = rig();
    await link.open();
    await link.open();
    expect(device.log.filter((entry) => entry === "open")).toHaveLength(1);
  });

  it("explains a browser with no WebUSB", async () => {
    const link = new WebUsbCanLink("candle", REQUEST, 0, { usb: undefined });
    await expect(link.open()).rejects.toThrow(/WebUSB is not available/);
  });

  it.each([
    ["NotFoundError", /no USB device was chosen/],
    ["SecurityError", /permission to use a USB device was denied/],
    ["NotAllowedError", /permission to use a USB device was denied/],
    ["TypeError", /cannot request a USB device/],
  ])("turns a %s from the picker into a TransportError", async (name, message) => {
    const { usb, link } = rig();
    usb.requestError = namedError(name, "refused");
    await expect(link.open()).rejects.toThrow(message);
    await expect(link.open()).rejects.toBeInstanceOf(TransportError);
  });

  it("releases a device that has no bulk endpoint pair", async () => {
    const { device, usb, link } = rig({ bulkEndpoints: false });
    await expect(link.open()).rejects.toThrow(/not a gs_usb adapter/);
    expect(device.closed).toBe(true);
    expect(usb.listenerCount).toBe(0);
  });

  it("refuses a channel the adapter does not have, and releases it", async () => {
    const { device, usb, link } = rig({ highestChannel: 0 }, 1);
    await expect(link.open()).rejects.toThrow(/1 CAN channel\(s\), so channel 1 does not exist/);
    expect(device.released).toBe(0);
    expect(device.closed).toBe(true);
    expect(usb.listenerCount).toBe(0);
  });

  it("reads the limits of the chosen channel", async () => {
    const { device, link } = rig({ highestChannel: 1 }, 1);
    await link.open();
    expect(device.controls.at(-1)?.setup.value).toBe(1);
  });

  it("releases the adapter when a setup request is refused", async () => {
    const { device, link } = rig({ stalledRequests: new Set([GS_USB_BREQ.hostFormat]) });
    await expect(link.open()).rejects.toThrow(/request 0 was refused \(stall\)/);
    expect(device.released).toBe(0);
    expect(device.closed).toBe(true);
  });

  it("refuses limits the adapter reports that no timing could use", async () => {
    const { device, link } = rig({ constantsReply: le32(1, 0, 1, 16, 1, 8, 4, 1, 1024, 1) });
    await expect(link.open()).rejects.toThrow(/cannot be used/);
    expect(device.closed).toBe(true);
  });
});

describe("configuring the channel", () => {
  it("sends the bit timing, then starts the channel, with receiving already running", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    const sent = device.controls.slice(3);
    expect(sent.map((c) => [c.setup.request, c.setup.value, c.setup.index])).toEqual([
      [GS_USB_BREQ.bitTiming, 0, 0],
      [GS_USB_BREQ.mode, 0, 0],
    ]);
    expect(sent[0]?.data).toEqual(le32(6, 7, 2, 1, 6));
    expect(sent[1]?.data).toEqual(le32(1, 0));
    const log = device.log;
    expect(log.indexOf("transfer in 1")).toBeGreaterThan(log.indexOf("control out 1"));
    expect(log.indexOf("transfer in 1")).toBeLessThan(log.lastIndexOf("control out 2"));
  });

  it("starts listen-only when asked and the adapter can", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(250_000, true);
    expect(device.controls.at(-1)?.data).toEqual(le32(1, 1));
  });

  it("refuses listen-only on an adapter without it, before anything is sent", async () => {
    const { device, link } = rig({
      constantsReply: le32(0, 48_000_000, 1, 16, 1, 8, 4, 1, 1024, 1),
    });
    await link.open();
    const before = device.controls.length;
    await expect(link.configure(500_000, true)).rejects.toThrow(
      /cannot start a channel listen-only/,
    );
    expect(device.controls).toHaveLength(before);
  });

  it("refuses a rate the adapter cannot make, before anything is sent", async () => {
    const { device, link } = rig({ constantsReply: le32(1, 48_000_000, 1, 16, 1, 8, 4, 1, 1, 1) });
    await link.open();
    const before = device.controls.length;
    await expect(link.configure(500_000, false)).rejects.toThrow(/no bit timing|% from/);
    expect(device.controls).toHaveLength(before);
  });

  it("stops a started channel before changing its timing", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    await link.configure(125_000, false);
    const requests = device.controls.slice(3).map((c) => [c.setup.request, c.data?.[0]]);
    expect(requests).toEqual([
      [GS_USB_BREQ.bitTiming, 6],
      [GS_USB_BREQ.mode, 1],
      [GS_USB_BREQ.mode, 0],
      [GS_USB_BREQ.bitTiming, 6],
      [GS_USB_BREQ.mode, 1],
    ]);
    expect(
      device.controls.filter((c) => c.setup.request === GS_USB_BREQ.bitTiming)[1]?.data,
    ).toEqual(le32(6, 7, 2, 1, 24));
  });

  it("needs an open link", async () => {
    const { link } = rig();
    await expect(link.configure(500_000, false)).rejects.toThrow(/not open/);
  });
});

describe("frames", () => {
  it("transmits a host frame on the bulk-out endpoint", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    await link.send(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)));
    await link.send(new CanFrame(0x18da10f1, Uint8Array.of(0xaa), true));
    expect(device.log).toContain("transfer out 2");
    expect(device.transmitted[0]).toEqual(
      Uint8Array.of(1, 0, 0, 0, 0xe0, 0x07, 0, 0, 3, 0, 0, 0, 2, 0x10, 0x92, 0, 0, 0, 0, 0),
    );
    expect([...(device.transmitted[1] ?? []).slice(0, 12)]).toEqual([
      2, 0, 0, 0, 0xf1, 0x10, 0xda, 0x98, 1, 0, 0, 0,
    ]);
  });

  it("pads for an adapter that asks for the LPC546XX workaround", async () => {
    const { device, link } = rig({
      constantsReply: le32(1 | (1 << 9), 48_000_000, 1, 16, 1, 8, 4, 1, 1024, 1),
    });
    await link.open();
    await link.configure(500_000, false);
    await link.send(new CanFrame(0x100, new Uint8Array(0)));
    expect(device.transmitted[0]).toHaveLength(21);
  });

  it("refuses to send before the channel is started", async () => {
    const { link } = rig();
    await expect(link.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(/not started/);
    await link.open();
    await expect(link.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(/not started/);
  });

  it("receives frames from the bus, in order, and not the echoes of its own", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    device.onTransmit = (packet) => {
      // The adapter confirms each transmitted frame with an echo carrying the host's identifier.
      device.deliver(packet.slice());
      device.deliverFrame(0x7e8, [0x50, 0x92]);
    };
    await link.send(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)));
    device.deliverFrame(0x18daf110, [], 0, true);
    expect(await link.receive(100)).toEqual(new CanFrame(0x7e8, Uint8Array.of(0x50, 0x92)));
    expect(await link.receive(100)).toEqual(new CanFrame(0x18daf110, new Uint8Array(0), true));
    await expect(link.receive(20)).rejects.toThrow(TransportTimeout);
  });

  it("ignores another channel's frames", async () => {
    const { device, link } = rig({ highestChannel: 1 });
    await link.open();
    await link.configure(500_000, false);
    device.deliverFrame(0x100, [1], 1);
    device.deliverFrame(0x101, [2], 0);
    expect(await link.receive(100)).toEqual(new CanFrame(0x101, Uint8Array.of(2)));
  });

  it("clears a stalled endpoint and keeps receiving", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    await settle();
    device.failNextTransferIn("stall");
    await settle();
    device.deliverFrame(0x7e8, [9]);
    expect(await link.receive(100)).toEqual(new CanFrame(0x7e8, Uint8Array.of(9)));
    expect(device.clearedHalts).toBe(1);
  });

  it("fails receiving, loudly, on a babble and on a truncated packet", async () => {
    const babble = rig();
    await babble.link.open();
    await babble.link.configure(500_000, false);
    await settle();
    babble.device.failNextTransferIn("babble");
    await expect(babble.link.receive(200)).rejects.toThrow(/more than a frame/);

    const truncated = rig();
    await truncated.link.open();
    await truncated.link.configure(500_000, false);
    truncated.device.deliver(new Uint8Array(5));
    await expect(truncated.link.receive(200)).rejects.toThrow(/shorter than its 12-byte header/);
  });
});

describe("disconnecting and closing", () => {
  it("reports an unplugged adapter on receive and send, and closes without touching it", async () => {
    const { device, usb, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    const waiting = link.receive(5000);
    device.unplug();
    usb.fireDisconnect(device);
    await expect(waiting).rejects.toThrow(/was disconnected/);
    await expect(link.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(
      /was disconnected/,
    );
    const requestsBefore = device.controls.length;
    await link.close();
    expect(device.controls).toHaveLength(requestsBefore);
    expect(device.released).toBeUndefined();
    expect(device.closed).toBe(true);
    expect(usb.listenerCount).toBe(0);
  });

  it("names a disconnect that the transfer reports before the event arrives", async () => {
    const { device, usb, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    device.unplug();
    await expect(link.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(
      /sending on the USB adapter failed/,
    );
    usb.fireDisconnect(device);
    await expect(link.receive(100)).rejects.toThrow(/was disconnected/);
  });

  it("ignores the disconnect of some other device", async () => {
    const { usb, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    usb.fireDisconnect({});
    await expect(link.receive(20)).rejects.toThrow(TransportTimeout);
  });

  it("stops the channel, releases the adapter and closes it", async () => {
    const { device, usb, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    await link.close();
    const stop = device.controls.at(-1);
    expect([stop?.setup.request, stop?.data]).toEqual([GS_USB_BREQ.mode, le32(0, 0)]);
    expect(device.log.slice(-2)).toEqual(["releaseInterface 0", "close"]);
    expect(usb.listenerCount).toBe(0);
    await expect(link.receive(10)).rejects.toThrow(/closed|not open|nothing/i);
    await expect(link.send(new CanFrame(0x100, new Uint8Array(0)))).rejects.toThrow(/not started/);
  });

  it("is safe to close repeatedly and before opening", async () => {
    const { device, link } = rig();
    await link.close();
    await link.open();
    await link.close();
    await link.close();
    expect(device.log.filter((entry) => entry === "close")).toHaveLength(1);
    expect(device.controls.at(-1)?.setup.request).toBe(GS_USB_BREQ.btConst);
  });

  it("can open again after closing", async () => {
    const { device, link } = rig();
    await link.open();
    await link.configure(500_000, false);
    await link.close();
    await link.open();
    await link.configure(500_000, false);
    device.deliverFrame(0x7e8, [1]);
    expect(await link.receive(100)).toEqual(new CanFrame(0x7e8, Uint8Array.of(1)));
    await link.close();
  });

  it("releases the adapter even when stopping the channel fails", async () => {
    const { device, link } = rig({ stalledRequests: new Set() });
    await link.open();
    await link.configure(500_000, false);
    device.controlTransferOut = () => Promise.reject(namedError("NetworkError", "transfer error"));
    await expect(link.close()).rejects.toThrow(/cannot stop the USB channel/);
    expect(device.released).toBe(0);
    expect(device.closed).toBe(true);
  });
});

describe("the webusb adapter URL", () => {
  it("builds a raw CAN transport and registers the scheme", () => {
    expect(openTransport("webusb://candle")).toBeInstanceOf(RawCanTransport);
  });

  it("filters the picker by vendor and product, or lists the gs_usb families", () => {
    expect(
      usbRequestFromParams(params("webusb://x?usbVendorId=0x1209&usbProductId=0x2323")),
    ).toEqual({
      filters: [{ vendorId: 0x1209, productId: 0x2323 }],
    });
    expect(usbRequestFromParams(params("webusb://x?usbVendorId=4617"))).toEqual({
      filters: [{ vendorId: 4617 }],
    });
    expect(usbRequestFromParams(new Map()).filters).toHaveLength(6);
  });

  it.each(["usbProductId=0x2323", "usbVendorId=abc", "channel=-1", "channel=x"])(
    "refuses %s",
    (query) => {
      expect(() => createWebUsbTransport(parseAdapterUrl(`webusb://x?${query}`))).toThrow(
        AdapterUrlError,
      );
    },
  );

  it("runs an ELM327 session over the adapter", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsb(device);
    const transport = createWebUsbTransport(parseAdapterUrl("webusb://candle"), usb.environment);
    device.onTransmit = (packet) => {
      const id = new DataView(packet.buffer, packet.byteOffset).getUint32(4, true);
      if (id === 0x7e0)
        device.deliverFrame(0x7e8, [0x02, 0x50, 0x92, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc]);
    };
    await transport.open();
    const elm = new Elm(transport);
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x7e0, 0x7e8);
    const replies = await elm.request(
      await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x92)),
    );
    expect(replies).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
    expect(device.controls.find((c) => c.setup.request === GS_USB_BREQ.bitTiming)?.data).toEqual(
      le32(6, 7, 2, 1, 6),
    );
    await transport.close();
    expect(device.closed).toBe(true);
  });
});
