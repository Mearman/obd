import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  ElmError,
  GuardError,
  KLineElm,
  Kwp2000,
  NoResponse,
  UnitSession,
  checksum,
  fromHex,
  obdReport,
  parseReplyLine,
  permit,
  readiness,
  selectBus,
  parseProfile,
  type KLineBus,
  type Profile,
  type KLineScheme,
} from "../src/core/index.js";
import { FakeKLineCore, fakeKLineTransport, replyLine } from "./helpers/fake-kline.js";
import { KLINE_PROFILE, edit } from "./support/profiles.js";

function engine(request: Uint8Array): Uint8Array {
  const [service = 0, first = 0] = request;
  if (service === 0x10) return Uint8Array.of(0x50, first);
  if (service === 0x1a) return Uint8Array.of(0x5a, 0x86, ...new TextEncoder().encode("06A906032"));
  if (service === 0x18) return Uint8Array.of(0x58, 0x01, 0x01, 0x23, 0x60);
  if (service === 0x01) return Uint8Array.of(0x41, first, 0xbe, 0x3e);
  return Uint8Array.of(0x7f, service, 0x11);
}

/** The profile of a K-line car with the given initialisation scheme. */
function klineProfile(scheme: KLineScheme): Profile {
  return parseProfile(
    edit(edit(KLINE_PROFILE, ["bus", "kline"], scheme), ["diagnostics", "session"], 0x81),
    "test",
  );
}

function bus(scheme: KLineScheme): KLineBus {
  const { bus: found } = klineProfile(scheme);
  if (found.kind !== "kline") throw new Error("not a K-line profile");
  return found;
}

/** A K-line session addressed to one unit, as the profile's units are. */
async function unit(
  core: FakeKLineCore,
  scheme: KLineScheme,
  address: number,
): Promise<{ elm: KLineElm; kwp: Kwp2000 }> {
  const elm = new KLineElm(fakeKLineTransport(core));
  await elm.selectKline(bus(scheme));
  await elm.addressUnit(address);
  return { elm, kwp: new Kwp2000(new UnitSession(elm, DiagProtocol.KWP2000, address), 0x81) };
}

it("takes the checksum as the modular sum", () => {
  expect(checksum(Uint8Array.of(0xff, 0x02))).toBe(0x01);
});

it("splits a reply line into source and data", () => {
  const line = replyLine(0x01, Uint8Array.of(0x41, 0x00, 0xbe));
  expect(parseReplyLine(line)).toEqual([0x01, Uint8Array.of(0x41, 0x00, 0xbe)]);
  const spaced = line.match(/../g)?.join(" ") ?? "";
  expect(parseReplyLine(spaced)[0]).toBe(0x01);
});

it.each(["", "48F101", "XYZ", "48F10141FF", replyLine(1, Uint8Array.of(0x41), { corrupt: true })])(
  "refuses the malformed reply line %j",
  (line) => {
    expect(() => parseReplyLine(line)).toThrow(ElmError);
  },
);

describe("over a K-line bus", () => {
  it("initialises each unit and reports who answers", async () => {
    const core = new FakeKLineCore({ 0x01: engine }, new Set([0x03]));
    const answered = new Map<number, boolean>();
    for (const address of [0x01, 0x03]) {
      const { kwp } = await unit(core, "kwp2000-slow", address);
      try {
        await kwp.start();
        await kwp.identification();
        answered.set(address, true);
      } catch (error) {
        if (!(error instanceof NoResponse)) throw error;
        answered.set(address, false);
      }
    }
    expect(answered).toEqual(
      new Map([
        [0x01, true],
        [0x03, false],
      ]),
    );
    const sent = core.sent;
    expect(sent).toContain("ATSP4");
    expect(sent.indexOf("ATIIA01")).toBeLessThan(sent.indexOf("ATSHC001F1"));
    expect(sent.indexOf("ATSHC001F1")).toBeLessThan(sent.indexOf("ATSI"));
    expect(sent).toContain("ATIIA03");
    expect(core.requests).toEqual(["1081", "1A86"]);
  });

  it("reads faults and identification", async () => {
    const core = new FakeKLineCore({ 0x01: engine });
    const { kwp } = await unit(core, "kwp2000-slow", 0x01);
    await kwp.start();
    expect(await kwp.faults()).toEqual([{ code: "0123", status: 0x60 }]);
    expect((await kwp.identification())[0]?.text).toContain("06A906032");
  });

  it("uses ATFI and no slow address for a fast initialisation", async () => {
    const core = new FakeKLineCore({ 0x01: engine });
    const { kwp } = await unit(core, "kwp2000-fast", 0x01);
    await kwp.start();
    expect(core.sent).toContain("ATFI");
    expect(core.sent).not.toContain("ATSI");
    expect(core.sent.some((line) => line.startsWith("ATIIA"))).toBe(false);
    expect(core.sent).toContain("ATSP5");
  });

  it("treats a reply that fails its checksum as an error, not data", async () => {
    const core = new FakeKLineCore({ 0x01: engine });
    core.corrupt = true;
    const { kwp } = await unit(core, "kwp2000-slow", 0x01);
    await expect(kwp.start()).rejects.toThrow(/fails its checksum/);
  });

  it("still refuses writes before anything is sent", async () => {
    const core = new FakeKLineCore({ 0x01: engine });
    const { elm } = await unit(core, "kwp2000-slow", 0x01);
    const session = new UnitSession(elm, DiagProtocol.KWP2000, 0x01);
    await expect(session.request(fromHex("2E0101"))).rejects.toThrow(GuardError);
    expect(core.requests).toEqual([]);
  });

  it("reads the legislated modes", async () => {
    const core = new FakeKLineCore({});
    // A functional request leaves the header at its default, so the fake answers from address 0.
    core.units[0x00] = engine;
    const elm = new KLineElm(fakeKLineTransport(core));
    await elm.selectKline(bus("iso9141"));
    await elm.addressFunctional();
    expect(core.sent).toContain("ATSP3");
    expect((await readiness(elm)).get(0)).toEqual({ lampOn: true, codeCount: 0x3e });
    const lines: string[] = [];
    expect(await obdReport(elm, (line) => lines.push(line))).toBe(0);
    expect(lines.some((line) => line.startsWith("unit 0: warning lamp"))).toBe(true);
  });

  it("fails an address before a protocol is selected", async () => {
    const elm = new KLineElm(fakeKLineTransport(new FakeKLineCore({})));
    await expect(elm.addressUnit(1)).rejects.toThrow(ElmError);
  });

  it("reports a silent initialisation as no response", async () => {
    const elm = new KLineElm(fakeKLineTransport(new FakeKLineCore({}, new Set([0]))));
    await elm.selectKline(bus("iso9141"));
    await elm.addressUnit(0);
    await expect(
      elm.request(await permit(DiagProtocol.OBD, Uint8Array.of(0x01, 0x00))),
    ).rejects.toThrow(NoResponse);
  });

  it("keeps CAN and K-line sessions apart", async () => {
    const klineSession = new KLineElm(fakeKLineTransport(new FakeKLineCore({})));
    await expect(klineSession.selectCan()).rejects.toThrow(ElmError);
    await expect(
      selectBus(new Elm(fakeKLineTransport(new FakeKLineCore({}))), klineProfile("kwp2000-slow")),
    ).rejects.toThrow(ElmError);
    await selectBus(klineSession, klineProfile("kwp2000-fast"));
  });

  it("refuses a write on K-line at the guard", async () => {
    await expect(permit(DiagProtocol.KWP2000, Uint8Array.of(0x2e, 0x01))).rejects.toThrow(
      GuardError,
    );
  });
});
