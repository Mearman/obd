/**
 * CAN extended addressing (ISO 15765-2), which BMW units use: the profile field, the ELM327 commands and reply parsing, the raw CAN link's framing, the scripted adapter, and the shipped BMW profiles. The bytes are invented except where a test says which source they follow.
 */

import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  EXTENDED_TESTER_ADDRESS,
  Elm,
  RawCanTransport,
  Receiver,
  ScriptedTransport,
  SIMULATED_VIN,
  UnitSession,
  asciiDecode,
  asciiEncode,
  checkProfile,
  concatBytes,
  flowControlFrame,
  fromHex,
  parseProfile,
  permit,
  segment,
} from "../src/core/index.js";
import { ExtendedAddressCanLink } from "./helpers/fake-can.js";
import { FakeElmCore, UdsEcu, fakeTransport } from "./helpers/fake-elm.js";
import { KLINE_PROFILE, MINIMAL, edit, type Json } from "./support/profiles.js";

/** The tester request identifier and reply base BMW uses, as docs/vehicles/bmw-mini.md records them. */
const BMW_REQUEST = 0x6f1;
const BMW_REPLY_BASE = 0x600;

const STN = { stnIdentity: "STN2255 v5.6.19" };

/** A profile of two invented units sharing one request identifier. */
const SHARED: Json = {
  ...MINIMAL,
  units: {
    first: {
      description: "First",
      request: BMW_REQUEST,
      response: 0x612,
      extended_address: 0x12,
      source: "made up for the test",
    },
    second: {
      description: "Second",
      request: BMW_REQUEST,
      response: 0x640,
      extended_address: 0x40,
      source: "made up for the test",
    },
  },
};

async function adapter(core: FakeElmCore): Promise<Elm> {
  const elm = new Elm(fakeTransport(core));
  await elm.initialise();
  await elm.selectCan(11, 500_000);
  core.sent.length = 0;
  return elm;
}

describe("the profile field", () => {
  it("loads into the unit", () => {
    const profile = parseProfile(SHARED, "test");
    expect(profile.units.get("first")?.extendedAddress).toBe(0x12);
    expect(parseProfile(MINIMAL, "test").units.get("engine")).not.toHaveProperty("extendedAddress");
  });

  it("lets units share a request identifier when their extended addresses differ", () => {
    expect(checkProfile(SHARED, "test")).toEqual([]);
  });

  it.each([
    [
      "the same extended address twice",
      edit(SHARED, ["units", "second", "extended_address"], 0x12),
      /request 0x6f1 to 0x12 is also used by first/,
    ],
    [
      "one identifier with and without an extended address",
      edit(SHARED, ["units", "second", "extended_address"], undefined),
      /request 0x6f1 is used with and without extended_address/,
    ],
    [
      "a shared response identifier",
      edit(SHARED, ["units", "second", "response"], 0x612),
      /response 0x612 is also used by first/,
    ],
    [
      "an extended address wider than a byte",
      edit(SHARED, ["units", "second", "extended_address"], 0x100),
      /must fit in one byte/,
    ],
  ])("reports %s", (_label, data, message) => {
    expect(checkProfile(data, "test").join("\n")).toMatch(message);
  });

  it("is refused on a K-line bus", () => {
    const kline = edit(KLINE_PROFILE, ["units", "engine", "extended_address"], 0x12);
    expect(() => parseProfile(kline, "test")).toThrow(/K-line bus has none/);
  });
});

describe("ISO-TP framing", () => {
  it("puts the target first in every frame and carries one byte less", () => {
    const payload = Uint8Array.from({ length: 12 }, (_, index) => index);
    const frames = segment(payload, 0x12);
    expect(frames.map((frame) => frame[0])).toEqual([0x12, 0x12, 0x12]);
    expect(frames[0]?.subarray(1, 3)).toEqual(Uint8Array.of(0x10, 12));
    expect(frames[0]?.subarray(3)).toEqual(payload.subarray(0, 5));
    expect(frames[1]?.subarray(1, 8)).toEqual(Uint8Array.of(0x21, 5, 6, 7, 8, 9, 10));
    expect(segment(Uint8Array.of(1, 2, 3, 4, 5, 6), 0x12)).toHaveLength(1);
    expect(segment(Uint8Array.of(1, 2, 3, 4, 5, 6, 7), 0x12)).toHaveLength(2);
  });

  it("reassembles only frames addressed to the receiver", () => {
    // Eleven bytes fill a first frame (five) and one consecutive frame (six).
    const payload = Uint8Array.from({ length: 11 }, (_, index) => index);
    const receiver = new Receiver(EXTENDED_TESTER_ADDRESS);
    const [first, second] = segment(payload, EXTENDED_TESTER_ADDRESS);
    if (first === undefined || second === undefined) throw new Error("expected two frames");
    expect(receiver.feed(0x612, first).sendFlowControl).toBe(true);
    const elsewhere = concatBytes(Uint8Array.of(0x40), second.subarray(1));
    expect(receiver.feed(0x612, elsewhere).message).toBeUndefined();
    expect(receiver.feed(0x612, second).message).toEqual(payload);
  });

  it("addresses a flow-control frame", () => {
    expect(flowControlFrame(0, 0, 0x12).subarray(0, 4)).toEqual(Uint8Array.of(0x12, 0x30, 0, 0));
  });
});

describe("the ELM327 session", () => {
  it("sets the extended address and puts it first in the flow control", async () => {
    const core = new FakeElmCore({});
    const elm = await adapter(core);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    expect(core.sent).toEqual([
      "ATSH6F1",
      "ATCRA612",
      "ATFCSH6F1",
      "ATFCSD12300000",
      "ATFCSM1",
      "ATCEA12",
    ]);
  });

  it("turns extended addressing off for a normal unit and for broadcasts", async () => {
    const core = new FakeElmCore({});
    const elm = await adapter(core);
    await elm.addressUnit(0x7e0, 0x7e8);
    expect(core.sent).not.toContain("ATCEA");
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    await elm.addressUnit(0x7e0, 0x7e8);
    expect(core.sent.at(-1)).toBe("ATCEA");
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    await elm.addressFunctional(0x7df);
    expect(core.sent.at(-1)).toBe("ATCEA");
    expect(core.extendedAddress).toBeUndefined();
  });

  it("reads a multi-frame reply, removing the tester address from each frame", async () => {
    const ecu = new UdsEcu(0x612, []);
    const core = new FakeElmCore({});
    core.addressedResponders[BMW_REQUEST] = { 0x12: ecu.respond };
    const elm = await adapter(core);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    const reply = await new UnitSession(elm, DiagProtocol.UDS, 0x612).request(fromHex("22F190"));
    expect(reply).toEqual(concatBytes(fromHex("62F190"), SIMULATED_VIN));
  });

  it("parses the reply line Quantex shows for BMW extended addressing", async () => {
    // "610F10662F1500F25F0": "610=CAN ID, F1=tester, 06=length, 62=response, F150=DID".
    const transport = new ScriptedTransport((written) => {
      const line = asciiDecode(written).trim();
      if (line === "") return new Uint8Array(0);
      return asciiEncode(`${line.startsWith("AT") ? "OK" : "610F10662F1500F25F0"}\r\r>`);
    });
    const elm = new Elm(transport);
    await elm.addressUnit(BMW_REQUEST, 0x610, 0x10);
    const replies = await elm.request(await permit(DiagProtocol.UDS, fromHex("22F150")));
    expect(replies.get(0x610)).toEqual([fromHex("62F1500F25F0")]);
  });

  it("refuses a reply that does not start with the tester address", async () => {
    const core = new FakeElmCore({});
    const elm = await adapter(core);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    // The adapter forgets the address, so the reply line has the PCI byte where F1 should be.
    core.extendedAddress = undefined;
    core.responders[BMW_REQUEST] = () => [[0x612, fromHex("620001")]];
    await expect(elm.request(await permit(DiagProtocol.UDS, fromHex("220001")))).rejects.toThrow(
      /does not start with the tester address F1/,
    );
  });

  it("leaves a plain adapter one byte less for a single-frame request", async () => {
    const ecu = new UdsEcu(0x612, []);
    const core = new FakeElmCore({});
    core.addressedResponders[BMW_REQUEST] = { 0x12: ecu.respond };
    const elm = await adapter(core);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    // Seven bytes fit a normal single frame but not one that starts with the address.
    const seven = await permit(DiagProtocol.UDS, fromHex("22F190F18CF18A"));
    await expect(elm.request(seven)).rejects.toThrow(/does not fit a single frame/);
    const six = await permit(DiagProtocol.UDS, fromHex("22F190F18C00"));
    await elm.request(six);
    expect(core.requests.at(-1)).toBe("22F190F18C00");
  });

  it("passes the extended address to STPX on an STN adapter", async () => {
    const ecu = new UdsEcu(0x612, []);
    const core = new FakeElmCore({}, STN);
    core.addressedResponders[BMW_REQUEST] = { 0x12: ecu.respond };
    const elm = new Elm(fakeTransport(core));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    const seven = await permit(DiagProtocol.UDS, fromHex("22F190F18CF18A"));
    await elm.request(seven);
    expect(core.sent.at(-1)).toBe("STPX H:6F1, D:22F190F18CF18A, X:12");
    expect(core.longRequests.at(-1)).toEqual(seven.payload);
  });
});

describe("the raw CAN link", () => {
  it("frames requests, flow control and replies with the extended addresses", async () => {
    const ecu = new UdsEcu(0x612, []);
    const link = new ExtendedAddressCanLink(BMW_REQUEST, BMW_REPLY_BASE, EXTENDED_TESTER_ADDRESS, [
      { address: 0x12, respond: ecu.respond },
    ]);
    const transport = new RawCanTransport(link, "test");
    const elm = new Elm(transport, { maxRequest: transport.maxRequest });
    await transport.open();
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(BMW_REQUEST, 0x612, 0x12);
    const reply = await new UnitSession(elm, DiagProtocol.UDS, 0x612).request(fromHex("22F190"));
    expect(reply).toEqual(concatBytes(fromHex("62F190"), SIMULATED_VIN));
    expect(link.sent.every((frame) => frame.canId === BMW_REQUEST && frame.data[0] === 0x12)).toBe(
      true,
    );
    // The request, then the flow control for the multi-frame reply.
    expect(link.sent.map((frame) => (frame.data[1] ?? 0) >> 4)).toEqual([0, 3]);
  });
});
