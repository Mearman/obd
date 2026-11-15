import { describe, expect, it } from "vitest";
import {
  AdapterUnsupported,
  DiagProtocol,
  Elm,
  ElmError,
  GuardError,
  NoResponse,
  ScriptedTransport,
  Transcript,
  fromHex,
  isotpReassemble,
  permit,
  toUpperHex,
} from "../src/core/index.js";
import {
  FakeElmCore,
  KwpEcu,
  fakeTransport,
  isotpFrames,
  type Responder,
} from "./helpers/fake-elm.js";

function make(core: FakeElmCore): Elm {
  return new Elm(fakeTransport(core));
}

const STN = { stnIdentity: "STN2255 v5.6.19" };

describe("initialise", () => {
  it("sends the set-up every request assumes", async () => {
    const core = new FakeElmCore({});
    const info = await make(core).initialise();
    expect(core.sent.slice(0, 8)).toEqual([
      "ATZ",
      "ATE0",
      "ATL0",
      "ATS0",
      "ATH1",
      "ATCAF1",
      "ATAT0",
      "ATSTFF",
    ]);
    expect(info.identity).toBe("ELM327 v2.3");
    expect(info.stnIdentity).toBeNull();
    expect(info.hasStnExtensions).toBe(false);
    expect(info.voltage).toBe("12.4V");
  });

  it("recognises an adapter with STN extensions", async () => {
    const info = await make(new FakeElmCore({}, STN)).initialise();
    expect(info.stnIdentity).toBe("STN2255 v5.6.19");
    expect(info.hasStnExtensions).toBe(true);
  });

  it("names an adapter missing a needed command", async () => {
    const core = new FakeElmCore({}, { unsupported: new Set(["ATFCSM1"]) });
    const elm = make(core);
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await expect(elm.addressUnit(0x784, 0x785)).rejects.toThrow(AdapterUnsupported);
    await expect(elm.addressUnit(0x784, 0x785)).rejects.toThrow(/ATFCSM1/);
  });
});

describe("addressing", () => {
  it("sets the header, filter and flow control for a unit", async () => {
    const core = new FakeElmCore({});
    const elm = make(core);
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x784, 0x785);
    expect(core.sent).toEqual([
      "ATSP6",
      "ATSH784",
      "ATCRA785",
      "ATFCSH784",
      "ATFCSD300000",
      "ATFCSM1",
    ]);
  });

  it("splits the priority from the header for 29-bit identifiers", async () => {
    const core = new FakeElmCore({});
    const elm = make(core);
    await elm.selectCan(29, 500_000);
    await elm.addressUnit(0x18da10f1, 0x18daf110);
    expect(core.sent.slice(0, 4)).toEqual(["ATSP7", "ATCP18", "ATSHDA10F1", "ATCRA18DAF110"]);
  });

  it("registers the flow-control pair on an STN adapter", async () => {
    const core = new FakeElmCore({}, STN);
    const elm = make(core);
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x784, 0x785);
    expect(core.sent).toContain("STCFCPA 784, 785");
    expect(core.flowControlPairs).toEqual(new Set([`${String(0x784)}:${String(0x785)}`]));
  });
});

describe("selectCan", () => {
  it("refuses a rate that is not a divisor of 500 kbit/s on a plain adapter", async () => {
    const core = new FakeElmCore({});
    await expect(make(core).selectCan(11, 83_333)).rejects.toThrow(/whole number/);
    expect(core.sent).toEqual([]);
  });

  it.each([0, -125_000])("refuses the non-positive bit rate %i", async (bitrate) => {
    await expect(make(new FakeElmCore({})).selectCan(11, bitrate)).rejects.toThrow(/positive/);
  });

  it("refuses an identifier width other than 11 or 29", async () => {
    await expect(make(new FakeElmCore({})).selectCan(12, 500_000)).rejects.toThrow(/11 or 29/);
  });

  it("uses user protocol B for 125 kbit/s on a plain adapter", async () => {
    const core = new FakeElmCore({});
    await make(core).selectCan(11, 125_000);
    expect(core.sent).toEqual(["ATPC", "ATPB 81 04", "ATSPB"]);
    expect(core.baud).toBe(125_000);
    expect(core.idChars).toBe(3);
  });

  it("sets the identifier width through user protocol B", async () => {
    const core = new FakeElmCore({});
    const elm = make(core);
    await elm.selectCan(29, 125_000);
    expect(core.sent).toEqual(["ATPC", "ATPB 01 04", "ATSPB"]);
    expect(core.idChars).toBe(8);
    await elm.addressUnit(0x18da10f1, 0x18daf110);
    expect(core.sent.slice(3, 5)).toEqual(["ATCP18", "ATSHDA10F1"]);
  });

  it("enforces the divisor limit of the user protocol", async () => {
    const core = new FakeElmCore({});
    await make(core).selectCan(11, 10_000);
    expect(core.sent[1]).toBe("ATPB 81 32");
    await expect(make(new FakeElmCore({})).selectCan(11, 5_000)).rejects.toThrow(/whole number/);
  });

  it("fails loudly on an adapter without user protocol B", async () => {
    const core = new FakeElmCore({}, { unsupported: new Set(["ATPB 81 04"]) });
    const rejection = make(core).selectCan(11, 125_000);
    await expect(rejection).rejects.toThrow(AdapterUnsupported);
    await expect(rejection).rejects.toThrow(/ATPB 81 04.*no user-defined CAN protocol/);
    expect(core.sent).not.toContain("ATSPB");
  });

  it("sets and verifies the rate on an STN adapter", async () => {
    const core = new FakeElmCore({}, STN);
    const elm = make(core);
    await elm.initialise();
    core.sent.length = 0;
    await elm.selectCan(11, 125_000);
    expect(core.sent).toEqual(["ATSP6", "STPBR 125000", "STPBRR"]);
    expect(core.baud).toBe(125_000);
  });

  it("refuses an STN adapter that rounds the rate", async () => {
    const core = new FakeElmCore({}, { ...STN, stnRateStep: 1000 });
    const elm = make(core);
    await elm.initialise();
    await expect(elm.selectCan(11, 83_333)).rejects.toThrow(
      "set 83000 bit/s when 83333 bit/s was requested",
    );
  });

  it("fails loudly when an STN adapter rejects the rate command", async () => {
    const core = new FakeElmCore({}, { ...STN, unsupported: new Set(["STPBR 125000"]) });
    const elm = make(core);
    await elm.initialise();
    const rejection = elm.selectCan(11, 125_000);
    await expect(rejection).rejects.toThrow(AdapterUnsupported);
    await expect(rejection).rejects.toThrow(/STPBR 125000/);
  });

  it("keeps the standard protocols on an STN adapter", async () => {
    const core = new FakeElmCore({}, STN);
    const elm = make(core);
    await elm.initialise();
    core.sent.length = 0;
    await elm.selectCan(29, 250_000);
    expect(core.sent).toEqual(["ATSP9"]);
  });
});

describe("request", () => {
  async function unit(core: FakeElmCore, withInitialise = false): Promise<Elm> {
    const elm = make(core);
    if (withInitialise) await elm.initialise();
    await elm.selectCan(11, 500_000);
    await elm.addressUnit(0x784, 0x785);
    return elm;
  }

  it("returns a single-frame reply", async () => {
    const elm = await unit(new FakeElmCore({ 0x784: new KwpEcu(0x785, []).respond }));
    const replies = await elm.request(await permit(DiagProtocol.KWP2000, fromHex("1092")));
    expect(replies).toEqual(new Map([[0x785, [fromHex("5092")]]]));
  });

  it("reassembles a multi-frame reply", async () => {
    const ecu = new KwpEcu(0x785, []);
    const elm = await unit(new FakeElmCore({ 0x784: ecu.respond }));
    const replies = await elm.request(await permit(DiagProtocol.KWP2000, fromHex("1A86")));
    expect(replies).toEqual(new Map([[0x785, [Uint8Array.of(0x5a, ...ecu.ident)]]]));
  });

  it("raises NoResponse for a silent unit", async () => {
    const elm = make(new FakeElmCore({}));
    await elm.selectCan(11, 500_000);
    await expect(elm.request(await permit(DiagProtocol.KWP2000, fromHex("1092")))).rejects.toThrow(
      NoResponse,
    );
  });

  it.each(["CAN ERROR", "BUFFER FULL", "BUS ERROR", "STOPPED"])(
    "raises the adapter error %s",
    async (line) => {
      class Erroring extends FakeElmCore {
        protected override handle(text: string): string {
          return text.startsWith("AT") ? "OK" : line;
        }
      }
      const elm = make(new Erroring({}));
      await expect(
        elm.request(await permit(DiagProtocol.KWP2000, fromHex("1092"))),
      ).rejects.toThrow(line);
    },
  );

  describe("longer than one frame", () => {
    const LONG_UDS_READ = fromHex("22F190F191F192F193F194");
    const longHex = toUpperHex(LONG_UDS_READ);

    function echoEcu(responseId: number): Responder {
      return (request) => [
        [
          responseId,
          Uint8Array.of(
            (request[0] ?? 0) + 0x40,
            ...request.slice(1, 3),
            ...Array.from({ length: 20 }, (_, index) => index),
          ),
        ],
      ];
    }

    it("is refused on a plain adapter", async () => {
      const core = new FakeElmCore({ 0x784: echoEcu(0x785) });
      const elm = await unit(core);
      const sent = core.sent.length;
      const request = await permit(DiagProtocol.UDS, LONG_UDS_READ);
      await expect(elm.request(request)).rejects.toThrow(/plain ELM327.*STN/);
      expect(core.sent.slice(sent)).toEqual([]);
    });

    it("goes through STPX on an STN adapter", async () => {
      const core = new FakeElmCore({ 0x784: echoEcu(0x785) }, STN);
      const elm = await unit(core, true);
      const replies = await elm.request(await permit(DiagProtocol.UDS, LONG_UDS_READ));
      expect(core.sent.at(-1)).toBe(`STPX H:784, D:${longHex}`);
      expect(core.longRequests).toEqual([LONG_UDS_READ]);
      expect(replies).toEqual(
        new Map([
          [0x785, [Uint8Array.of(0x62, 0xf1, 0x90, ...Array.from({ length: 20 }, (_, i) => i))]],
        ]),
      );
    });

    it("still sends a short request as plain hex on an STN adapter", async () => {
      const core = new FakeElmCore({ 0x784: echoEcu(0x785) }, STN);
      const elm = await unit(core, true);
      await elm.request(await permit(DiagProtocol.UDS, fromHex("22F190")));
      expect(core.sent.at(-1)).toBe("22F190");
    });

    it("names the full identifier for a 29-bit unit", async () => {
      const core = new FakeElmCore({ 0x18da10f1: echoEcu(0x18daf110) }, STN);
      const elm = make(core);
      await elm.initialise();
      await elm.selectCan(29, 500_000);
      await elm.addressUnit(0x18da10f1, 0x18daf110);
      await elm.request(await permit(DiagProtocol.UDS, LONG_UDS_READ));
      expect(core.sent.at(-1)?.startsWith("STPX H:18DA10F1, D:")).toBe(true);
    });

    it("fails loudly without a registered flow-control pair", async () => {
      const core = new FakeElmCore({ 0x784: echoEcu(0x785) }, STN);
      const elm = make(core);
      await elm.initialise();
      await elm.selectCan(11, 500_000);
      await elm.setHeader(0x784);
      await expect(elm.request(await permit(DiagProtocol.UDS, LONG_UDS_READ))).rejects.toThrow(
        "FB ERROR",
      );
    });

    it("names an STN adapter that rejects STPX", async () => {
      const core = new FakeElmCore(
        { 0x784: echoEcu(0x785) },
        { ...STN, unsupported: new Set([`STPX H:784, D:${longHex}`]) },
      );
      const elm = await unit(core, true);
      const request = await permit(DiagProtocol.UDS, LONG_UDS_READ);
      await expect(elm.request(request)).rejects.toThrow(AdapterUnsupported);
      await expect(elm.request(request)).rejects.toThrow(/STPX/);
    });

    it("is refused beyond the ISO-TP limit", async () => {
      const core = new FakeElmCore({}, STN);
      const elm = make(core);
      await elm.initialise();
      const sent = core.sent.length;
      const request = await permit(DiagProtocol.UDS, Uint8Array.of(0x22, ...new Uint8Array(4095)));
      await expect(elm.request(request)).rejects.toThrow("4095");
      expect(core.sent.slice(sent)).toEqual([]);
    });

    it("is still refused by the guard when it is a long write", async () => {
      await expect(
        permit(DiagProtocol.UDS, Uint8Array.of(...fromHex("2EF190"), ...new Uint8Array(20))),
      ).rejects.toThrow(GuardError);
    });

    it("goes as a plain request line on a link that segments in software", async () => {
      const core = new FakeElmCore({ 0x784: echoEcu(0x785) });
      const elm = new Elm(fakeTransport(core), { maxRequest: 4095 });
      await elm.selectCan(11, 500_000);
      await elm.addressUnit(0x784, 0x785);
      await elm.request(await permit(DiagProtocol.UDS, LONG_UDS_READ));
      expect(core.sent.at(-1)).toBe(longHex);
    });

    it("is refused beyond the limit of a link that segments in software", async () => {
      const elm = new Elm(fakeTransport(new FakeElmCore({})), { maxRequest: 12 });
      const request = await permit(DiagProtocol.UDS, Uint8Array.of(0x22, ...new Uint8Array(12)));
      await expect(elm.request(request)).rejects.toThrow("does not fit 12 bytes");
    });
  });
});

describe("command", () => {
  it("raises an error when no prompt arrives", async () => {
    const silent = new ScriptedTransport(() => new Uint8Array(0));
    await expect(new Elm(silent).command("ATI", 50)).rejects.toThrow(/no prompt/);
  });

  it("records every line sent and received", async () => {
    const elm = make(new FakeElmCore({}));
    await elm.command("ATI");
    expect(elm.transcript.entries.map((entry) => entry.split(" ").slice(1).join(" "))).toEqual([
      "> ATI",
      "< ELM327 v2.3",
    ]);
    expect(elm.transcript.entries[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]{12}\+00:00 > ATI$/);
  });

  it("removes an echo of the command from the reply", async () => {
    const echoing = new ScriptedTransport(() => new TextEncoder().encode("at i\rELM327 v2.3\r\r>"));
    expect(await new Elm(echoing).command("ATI")).toEqual(["ELM327 v2.3"]);
  });

  it("passes each transcript entry to a sink", async () => {
    const seen: string[] = [];
    const elm = new Elm(fakeTransport(new FakeElmCore({})), {
      transcript: new Transcript((entry) => seen.push(entry)),
    });
    await elm.command("ATI");
    expect(seen).toEqual(elm.transcript.entries);
    expect(seen).toHaveLength(2);
  });
});

describe("isotpReassemble", () => {
  it("round-trips a multi-frame message", () => {
    const payload = Uint8Array.from({ length: 40 }, (_, index) => index);
    const frames = isotpFrames(payload).map((frame): [number, Uint8Array] => [0x7e8, frame]);
    expect(isotpReassemble(frames)).toEqual(new Map([[0x7e8, [payload]]]));
  });

  it("keeps every message from a sender", () => {
    const frames: [number, Uint8Array][] = [
      [0x7e8, fromHex("037F1878")],
      [0x7e8, fromHex("025800")],
    ];
    expect(isotpReassemble(frames)).toEqual(
      new Map([[0x7e8, [fromHex("7F1878"), fromHex("5800")]]]),
    );
  });

  it("treats a cut-short message as an error", () => {
    const payload = Uint8Array.from({ length: 40 }, (_, index) => index);
    const frames = isotpFrames(payload)
      .map((frame): [number, Uint8Array] => [0x7e8, frame])
      .slice(0, -1);
    expect(() => isotpReassemble(frames)).toThrow(/cut short/);
  });

  it("treats an orphan continuation as an error", () => {
    expect(() => isotpReassemble([[0x7e8, fromHex("2101020304050607")]])).toThrow(ElmError);
  });
});
