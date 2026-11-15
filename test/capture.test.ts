import { describe, expect, it } from "vitest";
import {
  CAPTURE_FORMAT,
  CaptureError,
  FUNCTIONAL_ID,
  MAX_CAPTURE_TEXT,
  MAX_EXCHANGES,
  MAX_MESSAGE_BYTES,
  NotCaptured,
  NotCapturedBroadcast,
  ReplayElm,
  captureText,
  decodeCapture,
  decodedLines,
  makeClient,
  obdReport,
  parseCapture,
  permit,
  profileUnit,
  readThroughCapture,
  readUnit,
  scan,
  TransportError,
  KLineElm,
  buildCapture,
  captureAdapter,
  selectBus,
  type Capture,
  type Exchange,
} from "../src/core/index.js";
import { authored, record, shipped, simulatedSession } from "./helpers/captures.js";
import { FakeKLineCore, fakeKLineTransport } from "./helpers/fake-kline.js";

const W211 = shipped("mercedes-w211");
const MQB = shipped("vag-mqb");

/** A W211 car scanned with freeze frames, plus a read of the engine's one invented record. */
async function w211Capture(): Promise<Capture> {
  return record(W211, async (elm) => {
    await scan(elm, W211, { faults: true, freeze: true });
    const engine = profileUnit(W211, "engine");
    await elm.addressUnit(engine.requestId, engine.responseId);
    await makeClient(elm, W211, engine).readValue(0x99);
    await elm.addressFunctional(FUNCTIONAL_ID[11]);
    await obdReport(elm, () => undefined);
  });
}

/** The W211 profile with the engine unit only, as an older version of a profile might be. */
function engineOnly(values: Record<string, unknown> = {}): ReturnType<typeof authored> {
  return authored({
    name: "w211-engine",
    description: "Engine only",
    status: "unconfirmed",
    bus: { id_bits: 11, bitrate: 500_000 },
    diagnostics: { protocol: "kwp2000", session: 0x92 },
    units: {
      motor: {
        description: "Motor control unit",
        request: 0x7e0,
        response: 0x7e8,
        source: "test",
        values,
      },
    },
  });
}

describe("a capture document", () => {
  it("survives a round trip through its text", async () => {
    const capture = await w211Capture();
    const text = captureText(capture);
    expect(parseCapture(text, "capture.json")).toEqual(capture);
    // One exchange per line, so a file compares line by line.
    expect(text.split("\n").filter((line) => line.startsWith('    {"seq":'))).toHaveLength(
      capture.exchanges.length,
    );
  });

  it("keeps raw replies and negative responses, never decoded values", async () => {
    const capture = await w211Capture();
    const read = capture.exchanges.find((exchange) => exchange.request === "2199");
    expect(read?.outcome).toEqual({
      kind: "replies",
      replies: [{ sender: 0x7e8, messages: ["61990001"] }],
    });
    expect(read?.address).toEqual({
      mode: "physical",
      requestId: 0x7e0,
      responseId: 0x7e8,
      extendedAddress: null,
    });
    expect(read?.bus).toEqual({ kind: "can", idBits: 11, bitrate: 500_000 });
    expect(read?.protocol).toBe("kwp2000");
    const silent = capture.exchanges.find(
      (exchange) =>
        exchange.address?.mode === "functional" && exchange.outcome.kind === "no-response",
    );
    expect(silent?.outcome).toEqual({ kind: "no-response", message: "no control unit answered" });
    expect(JSON.stringify(capture)).not.toContain("coolant temperature");
  });
});

describe("parseCapture refuses hostile files", () => {
  const valid = async (): Promise<Record<string, unknown>> => {
    const parsed: unknown = JSON.parse(captureText(await w211Capture()));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return { ...parsed };
  };
  const withExchange = async (change: (exchange: Record<string, unknown>) => void) => {
    const document = await valid();
    const exchanges: unknown = document.exchanges;
    if (!Array.isArray(exchanges)) throw new Error("no exchanges");
    const first: unknown = exchanges[0];
    if (typeof first !== "object" || first === null) throw new Error("no first exchange");
    const copy: Record<string, unknown> = { ...first };
    change(copy);
    const rest: unknown[] = exchanges.slice(1);
    return JSON.stringify({ ...document, exchanges: [copy, ...rest] });
  };

  it.each([
    ["not JSON", () => Promise.resolve("{")],
    ["an array", () => Promise.resolve("[]")],
    ["a scan report", () => Promise.resolve('{"tool":"obd-read","units":[]}')],
    ["a newer version", async () => JSON.stringify({ ...(await valid()), version: 2 })],
    ["an unknown key", async () => JSON.stringify({ ...(await valid()), extra: 1 })],
    [
      "a prototype key",
      async () =>
        captureText(await w211Capture()).replace('"notes": [', '"__proto__": {"x": 1}, "notes": ['),
    ],
    ["an end before the start", async () => JSON.stringify({ ...(await valid()), endedAt: 0 })],
    ["no sessions", async () => JSON.stringify({ ...(await valid()), sessions: [] })],
    ["lower-case hexadecimal", () => withExchange((exchange) => (exchange.request = "1a86"))],
    ["an empty request", () => withExchange((exchange) => (exchange.request = ""))],
    ["odd hexadecimal", () => withExchange((exchange) => (exchange.request = "1A8"))],
    [
      "a request longer than ISO 15765-2 carries",
      () => withExchange((exchange) => (exchange.request = "22".repeat(MAX_MESSAGE_BYTES + 1))),
    ],
    ["a repeated sequence number", () => withExchange((exchange) => (exchange.seq = 1))],
    ["a session that does not exist", () => withExchange((exchange) => (exchange.session = 5))],
    ["a fractional time", () => withExchange((exchange) => (exchange.at = 1.5))],
    [
      "a negative identifier",
      () => withExchange((exchange) => (exchange.address = { mode: "any-reply", requestId: -1 })),
    ],
    ["an unknown protocol", () => withExchange((exchange) => (exchange.protocol = "ds2"))],
    [
      "an unknown outcome",
      () => withExchange((exchange) => (exchange.outcome = { kind: "maybe" })),
    ],
  ])("refuses %s", async (_label, build) => {
    const text = await build();
    expect(() => parseCapture(text, "hostile.json")).toThrow(CaptureError);
  });

  it("refuses a file over the size bound before parsing it", () => {
    const text = `{"format":"${CAPTURE_FORMAT}","pad":"${"x".repeat(MAX_CAPTURE_TEXT)}"}`;
    expect(() => parseCapture(text, "big.json")).toThrow(/more than the 33554432/);
  });

  it("refuses more exchanges than a capture holds", async () => {
    const document = await valid();
    const exchange: Exchange = {
      seq: 0,
      at: 0,
      session: 0,
      bus: null,
      address: null,
      protocol: null,
      request: "01",
      outcome: { kind: "no-response", message: "" },
    };
    const exchanges = Array.from({ length: MAX_EXCHANGES + 1 }, (_, seq) => ({ ...exchange, seq }));
    expect(() => parseCapture(JSON.stringify({ ...document, exchanges }), "many.json")).toThrow(
      CaptureError,
    );
  });

  it("names the version a newer file has", async () => {
    const text = JSON.stringify({ ...(await valid()), version: 7 });
    expect(() => parseCapture(text, "new.json")).toThrow(
      "new.json: capture version 7 is not one this program reads (it reads 1)",
    );
  });
});

describe("the replay session", () => {
  it("answers from the capture, reusing the last answer once the recorded ones are used", async () => {
    const capture = await w211Capture();
    const engine = profileUnit(W211, "engine");
    const replay = new ReplayElm(capture.exchanges, {
      bus: { kind: "can", idBits: 11, bitrate: 500_000 },
      address: null,
    });
    await replay.addressUnit(engine.requestId, engine.responseId);
    const session = await permit("kwp2000", Uint8Array.of(0x10, 0x92));
    expect(await replay.request(session)).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
    expect(await replay.request(session)).toEqual(new Map([[0x7e8, [Uint8Array.of(0x50, 0x92)]]]));
  });

  it("says when a request is not in the capture", async () => {
    const capture = await w211Capture();
    const replay = new ReplayElm(capture.exchanges);
    await replay.addressUnit(0x7e0, 0x7e8);
    await expect(
      replay.request(await permit("kwp2000", Uint8Array.of(0x21, 0x01))),
    ).rejects.toThrow(NotCaptured);
    await replay.addressFunctional(FUNCTIONAL_ID[11]);
    await expect(replay.request(await permit("obd", Uint8Array.of(0x01, 0x0c)))).rejects.toThrow(
      NotCapturedBroadcast,
    );
    expect(replay.missing).toEqual(["7E0 -> 7E8 2101", "functional 7DF 010C"]);
  });

  it("does not answer a request recorded on another bus", async () => {
    const capture = await w211Capture();
    const replay = new ReplayElm(capture.exchanges);
    await replay.selectCan(29, 500_000);
    await replay.addressUnit(0x7e0, 0x7e8);
    await expect(
      replay.request(await permit("kwp2000", Uint8Array.of(0x10, 0x92))),
    ).rejects.toThrow(NotCaptured);
  });

  it("sends nothing to an adapter", async () => {
    const replay = new ReplayElm([]);
    await expect(replay.initialise()).rejects.toThrow("no adapter");
    await expect(replay.require("ATZ")).rejects.toThrow("no adapter");
  });
});

describe("decodeCapture", () => {
  it("decodes a scan capture to what the live scan read", async () => {
    const { elm } = await simulatedSession(W211);
    const live = await scan(elm, W211, { faults: true, freeze: true });
    const capture = await w211Capture();
    const decoded = await decodeCapture(capture, { kind: "profile", profile: W211 });
    expect(decoded.units).toEqual(live);
  });

  it("gives the same result every time", async () => {
    const capture = await w211Capture();
    const first = await decodeCapture(capture, { kind: "profile", profile: W211 });
    const second = await decodeCapture(capture, { kind: "profile", profile: W211 });
    expect(second).toEqual(first);
    expect(decodedLines(second)).toEqual(decodedLines(first));
  });

  it("decodes the same capture differently under two profiles", async () => {
    const capture = await w211Capture();
    const asW211 = await decodeCapture(capture, { kind: "profile", profile: W211 });
    const asMqb = await decodeCapture(capture, { kind: "profile", profile: MQB });
    const w211Engine = asW211.units.find((unit) => unit.unit === "engine");
    const mqbEngine = asMqb.units.find((unit) => unit.unit === "engine");
    expect(w211Engine?.faults).toEqual([{ code: "1234", status: "20" }]);
    expect(w211Engine?.identification.get("identification")?.text).toBe("A6421500000 E280CDI");
    // vag-mqb reads the same address with UDS: the capture holds none of its reads there.
    expect(mqbEngine?.faults).toBeNull();
    expect(mqbEngine?.notes).toEqual([
      "session request failed: request 7E0 -> 7E8 1001 is not in the capture",
    ]);
    expect(asMqb.units.find((unit) => unit.unit === "gateway")?.notes).toEqual([
      "not in this capture",
    ]);
  });

  it("decodes an old capture under an updated profile", async () => {
    const capture = await w211Capture();
    const before = await decodeCapture(capture, { kind: "profile", profile: engineOnly() });
    const after = await decodeCapture(capture, {
      kind: "profile",
      profile: engineOnly({
        record: { label: "invented record", identifier: 0x99, size: 2, source: "test" },
      }),
    });
    expect(before.values).toEqual([]);
    expect(before.undecoded.map((exchange) => exchange.request)).toContain("2199");
    expect(after.values.map(({ unit, label, value }) => ({ unit, label, value }))).toEqual([
      { unit: "motor", label: "invented record", value: 1 },
    ]);
    expect(after.undecoded.map((exchange) => exchange.request)).not.toContain("2199");
    expect(after.units[0]?.unit).toBe("motor");
  });

  it("keeps every exchange no profile unit uses, raw", async () => {
    const capture = await w211Capture();
    const decoded = await decodeCapture(capture, { kind: "profile", profile: engineOnly() });
    const esp = decoded.undecoded.filter(
      (exchange) => exchange.address?.mode === "physical" && exchange.address.requestId === 0x784,
    );
    expect(esp.map((exchange) => exchange.request)).toEqual([
      "1092",
      "1A86",
      "1802FF00",
      "12FF041234",
    ]);
    const lines = decodedLines(decoded);
    expect(lines).toContain("  #" + String(esp[0]?.seq) + " 784 -> 785 1092: 785 5092");
    expect(decoded.exchanges).toBe(capture.exchanges.length);
  });

  it("decodes the legislated reads under any profile and with none", async () => {
    const capture = await w211Capture();
    const generic = await decodeCapture(capture, { kind: "generic" });
    const profiled = await decodeCapture(capture, { kind: "profile", profile: W211 });
    expect(generic.obd?.vin).toBe("SIMULATEDCAR00001");
    expect(profiled.obd).toEqual(generic.obd);
    expect(generic.obdLines[0]).toBe("VIN: SIMULATEDCAR00001");
    // With no profile, every unit exchange stays raw.
    expect(generic.undecoded.some((exchange) => exchange.request === "1A86")).toBe(true);
    expect(decodedLines(generic)[0]).toBe(
      "decoded with no profile: the legislated OBD-II reads only",
    );
  });
});

describe("decodeCapture on other sessions and buses", () => {
  it("stands in a session the capture opened when the profile's differs", async () => {
    const defaultSession = authored({
      name: "w211-default-session",
      description: "Engine read in the default session",
      status: "unconfirmed",
      bus: { id_bits: 11, bitrate: 500_000 },
      diagnostics: { protocol: "kwp2000", session: 0x81 },
      units: {
        engine: { description: "Engine", request: 0x7e0, response: 0x7e8, source: "test" },
      },
    });
    const capture = await record(defaultSession, (elm) =>
      scan(elm, defaultSession, { faults: true, freeze: false }),
    );
    const decoded = await decodeCapture(capture, { kind: "profile", profile: W211 });
    const engine = decoded.units.find((unit) => unit.unit === "engine");
    expect(engine?.faults).toEqual([{ code: "1234", status: "20" }]);
    expect(engine?.notes).toEqual([
      "decoded with the session the capture opened (10 81), not the profile's (10 92)",
    ]);
  });

  it("decodes a K-line capture", async () => {
    const kline = authored({
      name: "old-car",
      description: "Example K-line car",
      status: "unconfirmed",
      bus: { kline: "kwp2000-slow" },
      diagnostics: { protocol: "kwp2000", session: 0x81 },
      units: { engine: { description: "Engine", request: 1, response: 1, source: "test" } },
    });
    const core = new FakeKLineCore({
      1: (request) => {
        if (request[0] === 0x10) return Uint8Array.of(0x50, 0x81);
        if (request[0] === 0x1a) return Uint8Array.of(0x5a, 0x86, 0x41, 0x42);
        if (request[0] === 0x18) return Uint8Array.of(0x58, 0x01, 0x12, 0x34, 0x20);
        return undefined;
      },
    });
    const elm = new KLineElm(fakeKLineTransport(core));
    const adapter = await elm.initialise();
    await selectBus(elm, kline);
    const live = await readThroughCapture(elm, (session) =>
      scan(session, kline, { faults: true, freeze: false }),
    );
    const capture = buildCapture(
      {
        id: "kline",
        startedAt: 0,
        endedAt: 0,
        origin: { kind: "scan", profile: "old-car", complete: true, description: "test" },
        session: {
          adapter: captureAdapter(adapter, null),
          tool: { name: "obd-read", version: "test" },
        },
      },
      live.exchanges,
    );
    expect(capture.exchanges[0]?.bus).toEqual({
      kind: "kline",
      scheme: "kwp2000-slow",
      tester: 0xf1,
      headerFormat: 0xc0,
    });
    const decoded = await decodeCapture(capture, { kind: "profile", profile: kline });
    expect(decoded.units).toEqual(live.result);
    expect(decoded.units[0]?.faults).toEqual([{ code: "1234", status: "20" }]);
    expect(decoded.undecoded).toEqual([]);
  });
});

describe("readThroughCapture", () => {
  it("returns what the read decodes from its own exchanges", async () => {
    const { elm } = await simulatedSession(W211);
    const unit = profileUnit(W211, "esp");
    const { result, exchanges } = await readThroughCapture(elm, (session) =>
      readUnit(session, W211, unit, { faults: true, freeze: true }),
    );
    expect(result.faults).toEqual([{ code: "1234", status: "20" }]);
    expect(exchanges.map((exchange) => exchange.request)).toEqual([
      "1092",
      "1A86",
      "1802FF00",
      "12FF041234",
    ]);
  });

  it.each([
    ["a link failure", () => new TransportError("the link dropped")],
    ["a failure the session does not record", () => new Error("the car went away")],
  ])(
    "stops printing where the live read failed on %s, and reports its error",
    async (_label, failure) => {
      const { elm, car } = await simulatedSession(W211);
      await elm.addressFunctional(FUNCTIONAL_ID[11]);
      let sent = 0;
      const original = car.responders[0x7df];
      const error = failure();
      car.responders[0x7df] = (request) => {
        sent += 1;
        if (sent > 1) throw error;
        return original?.(request) ?? [];
      };
      const lines: string[] = [];
      await expect(
        readThroughCapture(
          elm,
          (session, out) => obdReport(session, out),
          (line) => lines.push(line),
        ),
      ).rejects.toBe(error);
      expect(lines).toEqual(["VIN: SIMULATEDCAR00001"]);
    },
  );
});
