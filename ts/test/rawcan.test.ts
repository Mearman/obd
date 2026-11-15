import { describe, expect, it } from "vitest";
import {
  CanFrame,
  DiagProtocol,
  Elm,
  ElmError,
  GuardError,
  Kwp2000,
  NoResponse,
  RawCanTransport,
  SlcanLink,
  TransportError,
  TransportTimeout,
  UnitSession,
  asciiDecode,
  asciiEncode,
  concatBytes,
  decodeFrame,
  encodeFrame,
  fromHex,
  permit,
  requestFor,
  responseFor,
  segment,
  swapAddresses,
  type Transport,
} from "../src/core/index.js";
import { FakeCanLink, type CanResponder } from "./helpers/fake-can.js";
import { KwpEcu } from "./helpers/fake-elm.js";

/** A fake W211 on a raw CAN link. */
class RawCar {
  readonly esp = new KwpEcu(0x785, [[0x5123, 0x61]]);
  readonly link = new FakeCanLink(
    { 0x7e0: new KwpEcu(0x7e8, []).respond, 0x784: this.esp.respond },
    { 0x7e0: 0x7e8, 0x784: 0x785 },
  );
  readonly transport = new RawCanTransport(this.link, "test");

  /** A session on the link, initialised and on 11-bit 500 kbit/s CAN. */
  async elm(): Promise<Elm> {
    const elm = new Elm(this.transport, { maxRequest: this.transport.maxRequest });
    await this.transport.open();
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    return elm;
  }

  async client(elm: Elm, requestId: number, responseId: number): Promise<Kwp2000> {
    await elm.addressUnit(requestId, responseId);
    return new Kwp2000(new UnitSession(elm, DiagProtocol.KWP2000, responseId), 0x92);
  }
}

describe("a raw CAN link", () => {
  it("works for probing and fault reading", async () => {
    const car = new RawCar();
    const elm = await car.elm();
    const answered = new Map<string, boolean>();
    for (const [name, request, response] of [
      ["engine", 0x7e0, 0x7e8],
      ["esp", 0x784, 0x785],
      ["kombi", 0x796, 0x797],
    ] as const) {
      const client = await car.client(elm, request, response);
      try {
        await client.start();
        answered.set(name, true);
      } catch (error) {
        if (!(error instanceof NoResponse)) throw error;
        answered.set(name, false);
      }
    }
    expect(answered).toEqual(
      new Map([
        ["engine", true],
        ["esp", true],
        ["kombi", false],
      ]),
    );
    expect(car.link.configured).toEqual([[500_000, false]]);
    expect(car.link.opened).toBe(true);
    const client = await car.client(elm, 0x784, 0x785);
    expect(await client.faults()).toEqual([{ code: "5123", status: 0x61 }]);
    await car.transport.close();
    expect(car.link.closed).toBe(true);
  });

  it("gets flow control from the tool for multi-frame replies", async () => {
    const car = new RawCar();
    const client = await car.client(await car.elm(), 0x784, 0x785);
    expect((await client.identification())[0]?.text).toContain("A6421500000 E280CDI");
    const control = car.link.sent.filter((frame) => (frame.data[0] ?? 0) >> 4 === 3);
    expect(control.length).toBeGreaterThan(0);
    expect(control.every((frame) => frame.canId === 0x784)).toBe(true);
    expect(control[0]?.data.slice(0, 3)).toEqual(Uint8Array.of(0x30, 0, 0));
  });

  it("sends requests longer than one frame segmented", async () => {
    const car = new RawCar();
    const elm = await car.elm();
    await elm.addressUnit(0x784, 0x785);
    const request = fromHex(`21${"00".repeat(12)}`);
    const seen: Uint8Array[] = [];
    const unit: CanResponder = (payload) => {
      seen.push(payload);
      return [[0x785, Uint8Array.of(0x61, 0x00)]];
    };
    car.link.responders[0x784] = unit;
    const reply = await new UnitSession(elm, DiagProtocol.KWP2000, 0x785).request(request);
    expect(seen).toEqual([request]);
    expect(car.link.sent[0]?.data).toEqual(segment(request)[0]);
    expect(reply).toEqual(Uint8Array.of(0x61, 0x00));
  });

  it("still refuses writes before anything is sent", async () => {
    const car = new RawCar();
    const elm = await car.elm();
    await elm.addressUnit(0x784, 0x785);
    const session = new UnitSession(elm, DiagProtocol.KWP2000, 0x785);
    await expect(session.request(fromHex("2E0101"))).rejects.toThrow(GuardError);
    expect(car.link.sent).toEqual([]);
  });

  it("reports a silent unit as no response and a cut-short reply as an error", async () => {
    const link = new FakeCanLink({});
    const transport = new RawCanTransport(link);
    const elm = new Elm(transport, { maxRequest: 4095 });
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x7e0, 0x7e8);
    await expect(
      elm.request(await permit(DiagProtocol.OBD, Uint8Array.of(0x01, 0x00))),
    ).rejects.toThrow(NoResponse);
    link.inject(0x7e8, Uint8Array.of(0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x32, 0x33));
    const injected = link.queue.pop();
    if (injected !== undefined) link.queue.unshift(injected); // the cut-short first frame is already on the bus
    await expect(
      elm.request(await permit(DiagProtocol.OBD, Uint8Array.of(0x09, 0x02))),
    ).rejects.toThrow(/cut short/);
  });

  it("collects every responder to a functional request", async () => {
    const link = new FakeCanLink({
      0x7e0: (request) => [[0x7e8, Uint8Array.of(0x41, request[1] ?? 0, 1)]],
      0x7e1: (request) => [[0x7e9, Uint8Array.of(0x41, request[1] ?? 0, 2)]],
    });
    const elm = new Elm(new RawCanTransport(link));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressFunctional(0x7df);
    const replies = await elm.request(await permit(DiagProtocol.OBD, Uint8Array.of(0x01, 0x05)));
    expect(replies).toEqual(
      new Map([
        [0x7e8, [Uint8Array.of(0x41, 5, 1)]],
        [0x7e9, [Uint8Array.of(0x41, 5, 2)]],
      ]),
    );
  });

  it("pairs identifiers for 29-bit addressing", async () => {
    const link = new FakeCanLink({
      0x18da10f1: () => [[0x18daf110, Uint8Array.of(0x50, 0x81)]],
    });
    const elm = new Elm(new RawCanTransport(link));
    await elm.initialise();
    await elm.selectCan(29, 250_000);
    await elm.addressUnit(0x18da10f1, 0x18daf110);
    const replies = await elm.request(
      await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x81)),
    );
    expect(replies).toEqual(new Map([[0x18daf110, [Uint8Array.of(0x50, 0x81)]]]));
    expect(link.configured).toEqual([[250_000, false]]);
    expect(link.sent[0]?.extended).toBe(true);
    expect(link.sent[0]?.canId).toBe(0x18da10f1);
  });

  it("refuses unsupported commands as a clone adapter would", async () => {
    const transport = new RawCanTransport(new FakeCanLink({}));
    for (const command of ["ATSP1", "ATH0", "ATD", "ATSH12", "0100"]) {
      await transport.write(asciiEncode(`${command}\r`));
      expect(asciiDecode(await transport.read()).startsWith("?")).toBe(true);
    }
    await expect(transport.read()).rejects.toThrow(TransportError);
  });

  it.each([
    [11, 125_000],
    [29, 100_000],
    [11, 10_000],
  ])(
    "takes other bit rates through user protocol B (%i bits, %i bit/s)",
    async (idBits, bitrate) => {
      const link = new FakeCanLink({});
      const elm = new Elm(new RawCanTransport(link));
      await elm.initialise();
      await elm.selectCan(idBits, bitrate);
      expect(link.configured).toEqual([[bitrate, false]]);
    },
  );

  it("refuses a rate the session cannot express before the link is touched", async () => {
    const link = new FakeCanLink({});
    const elm = new Elm(new RawCanTransport(link));
    await elm.initialise();
    await expect(elm.selectCan(11, 83_333)).rejects.toThrow(/whole number/);
    await expect(elm.selectCan(11, 83_333)).rejects.toThrow(ElmError);
    expect(link.configured).toEqual([]);
  });
});

it("pairs request and response identifiers", () => {
  expect(responseFor(0x7e0, 11)).toBe(0x7e8);
  expect(requestFor(0x7e8, 11)).toBe(0x7e0);
  expect(swapAddresses(0x18daf110)).toBe(0x18da10f1);
  expect(responseFor(0x18da10f1, 29)).toBe(0x18daf110);
});

describe("SLCAN", () => {
  /** A byte pipe that behaves like an SLCAN adapter, with frames to deliver and commands recorded. */
  class FakeSlcanDevice implements Transport {
    readonly commands: string[] = [];
    incoming: Uint8Array = new Uint8Array(0);
    opened = false;
    closed = false;

    constructor(private readonly refuse: ReadonlySet<string> = new Set()) {}

    deliver(text: string): void {
      this.incoming = concatBytes(this.incoming, asciiEncode(text));
    }

    open(): Promise<void> {
      this.opened = true;
      return Promise.resolve();
    }

    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }

    write(data: Uint8Array): Promise<void> {
      for (const text of asciiDecode(data).split("\r").slice(0, -1)) {
        this.commands.push(text);
        if (this.refuse.has(text)) this.deliver("\x07");
        else if (text.startsWith("t") || text.startsWith("T")) this.deliver("z\r");
        else this.deliver("\r");
      }
      return Promise.resolve();
    }

    read(): Promise<Uint8Array> {
      if (this.incoming.length === 0) return Promise.reject(new TransportTimeout("quiet"));
      const data = this.incoming.slice(0, 3);
      this.incoming = this.incoming.slice(3);
      return Promise.resolve(data);
    }
  }

  it("writes frame text", () => {
    expect(encodeFrame(new CanFrame(0x456, Uint8Array.of(0x11, 0x22, 0x33)))).toEqual(
      asciiEncode("t4563112233\r"),
    );
    expect(encodeFrame(new CanFrame(0x12abcdef, Uint8Array.of(0xaa, 0x55), true))).toEqual(
      asciiEncode("T12ABCDEF2AA55\r"),
    );
  });

  it("reads frame text", () => {
    expect(decodeFrame(asciiEncode("t1230"))).toEqual(new CanFrame(0x123, new Uint8Array(0)));
    expect(decodeFrame(asciiEncode("T12ABCDEF2AA55"))).toEqual(
      new CanFrame(0x12abcdef, Uint8Array.of(0xaa, 0x55), true),
    );
    expect(decodeFrame(asciiEncode("r1230"))).toBeUndefined();
    expect(decodeFrame(asciiEncode("z"))).toBeUndefined();
    expect(() => decodeFrame(asciiEncode("t12331122"))).toThrow(TransportError);
  });

  it("configures, sends and receives", async () => {
    const device = new FakeSlcanDevice(new Set(["C"]));
    const link = new SlcanLink(device);
    await link.open();
    await link.configure(500_000, false);
    expect(device.commands).toEqual(["C", "S6", "O"]);
    await link.send(new CanFrame(0x7e0, Uint8Array.of(2, 0x10, 0x92)));
    expect(device.commands.at(-1)).toBe("t7E03021092");
    device.deliver("t7E825092\r");
    device.deliver("T18DAF1100\r");
    expect(await link.receive(100)).toEqual(new CanFrame(0x7e8, Uint8Array.of(0x50, 0x92)));
    expect(await link.receive(100)).toEqual(new CanFrame(0x18daf110, new Uint8Array(0), true));
    await link.close();
    expect(device.commands.at(-1)).toBe("C");
    expect(device.closed).toBe(true);
  });

  it("listens only and refuses what the adapter refuses", async () => {
    const device = new FakeSlcanDevice();
    const link = new SlcanLink(device);
    await link.configure(250_000, true);
    expect(device.commands).toEqual(["C", "S5", "L"]);
    await expect(link.configure(83_333, false)).rejects.toThrow(/no setting/);
    await expect(
      new SlcanLink(new FakeSlcanDevice(new Set(["S6"]))).configure(500_000, false),
    ).rejects.toThrow(/refused/);
  });

  it("runs a session", async () => {
    const device = new FakeSlcanDevice();
    const elm = new Elm(new RawCanTransport(new SlcanLink(device)));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x7e0, 0x7e8);
    device.deliver("t7E88025092CCCCCCCCCC\r");
    const replies = await elm.request(
      await permit(DiagProtocol.KWP2000, Uint8Array.of(0x10, 0x92)),
    );
    expect(replies).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
    expect(device.commands).toContain("t7E08021092CCCCCCCCCC");
  });
});
