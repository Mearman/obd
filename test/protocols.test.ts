import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  FUNCTIONAL_ID,
  PIDS,
  STORED_CODES,
  decodeCode,
  readAnswers,
  readPid,
  readiness,
  vin,
  codes,
  ElmError,
  GuardError,
  Kwp2000,
  MemorySnapshotStore,
  NegativeResponse,
  Uds,
  UnitSession,
  asciiEncode,
  authoriseClear,
  fromHex,
  toHex,
  toUpperHex,
  type Fault,
} from "../src/core/index.js";
import { FakeElmCore, KwpEcu, fakeTransport, type Responder } from "./helpers/fake-elm.js";

async function session(
  responder: Responder,
  protocol: DiagProtocol,
): Promise<[UnitSession, FakeElmCore]> {
  const core = new FakeElmCore({ 0x784: responder });
  const elm = new Elm(fakeTransport(core));
  await elm.selectCan(11, 500_000);
  await elm.addressUnit(0x784, 0x785);
  return [new UnitSession(elm, protocol, 0x785), core];
}

function fixed(response: string): Responder {
  return () => [[0x785, fromHex(response)]];
}

describe("KWP2000", () => {
  it("reads identification and faults", async () => {
    const ecu = new KwpEcu(0x785, [
      [0x5123, 0x61],
      [0x9003, 0x20],
    ]);
    const [unit, core] = await session(ecu.respond, DiagProtocol.KWP2000);
    const client = new Kwp2000(unit, 0x92);
    await client.start();
    expect((await client.identification())[0]?.text).toBe("A6421500000 E280CDI");
    expect(await client.faults()).toEqual([
      { code: "5123", status: 0x61 },
      { code: "9003", status: 0x20 },
    ]);
    expect(core.requests).toEqual(["1092", "1A86", "1802FF00"]);
  });

  it("selects a freeze frame by fault code", async () => {
    const [unit, core] = await session(
      new KwpEcu(0x785, [[0x5123, 0x61]]).respond,
      DiagProtocol.KWP2000,
    );
    const frame = await new Kwp2000(unit, 0x92).freezeFrame({ code: "5123", status: 0x61 });
    expect(core.requests).toEqual(["12FF045123"]);
    expect(frame).toEqual(fromHex("0151230C8A31"));
  });

  it("reads a local identifier", async () => {
    const ecu = new KwpEcu(0x785, []);
    ecu.records.set(0x99, fromHex("0001"));
    const [unit] = await session(ecu.respond, DiagProtocol.KWP2000);
    expect(await new Kwp2000(unit, 0x92).readValue(0x99)).toEqual(fromHex("0001"));
    const [other] = await session(fixed("6198FF"), DiagProtocol.KWP2000);
    await expect(new Kwp2000(other, 0x92).readValue(0x99)).rejects.toThrow(
      /does not answer local identifier 99/,
    );
  });

  it("treats a fault count mismatch as an error", async () => {
    const [unit] = await session(fixed("58025123"), DiagProtocol.KWP2000);
    await expect(new Kwp2000(unit, 0x92).faults()).rejects.toThrow(/declares 2/);
  });

  it("names the service and code of a negative response", async () => {
    const [unit] = await session(
      (request) => [[0x785, Uint8Array.of(0x7f, request[0] ?? 0, 0x11)]],
      DiagProtocol.KWP2000,
    );
    const refusal = await new Kwp2000(unit, 0x92).faults().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NegativeResponse);
    if (!(refusal instanceof NegativeResponse)) return;
    expect(refusal.message).toMatch(/service not supported/);
    expect([refusal.service, refusal.code]).toEqual([0x18, 0x11]);
  });

  it("uses the final reply after a pending one", async () => {
    const [unit] = await session(
      (request) => [
        [0x785, Uint8Array.of(0x7f, request[0] ?? 0, 0x78)],
        [0x785, fromHex("5800")],
      ],
      DiagProtocol.KWP2000,
    );
    expect(await new Kwp2000(unit, 0x92).faults()).toEqual([]);
  });

  it("treats a pending reply with no final reply as an error", async () => {
    const [unit] = await session(
      (request) => [[0x785, Uint8Array.of(0x7f, request[0] ?? 0, 0x78)]],
      DiagProtocol.KWP2000,
    );
    await expect(new Kwp2000(unit, 0x92).faults()).rejects.toThrow(/more time/);
  });

  it("treats a reply from another unit as an error", async () => {
    const [unit] = await session(() => [[0x7e8, fromHex("5800")]], DiagProtocol.KWP2000);
    await expect(new Kwp2000(unit, 0x92).faults()).rejects.toThrow(/expected a reply from 785/);
  });

  it("treats a reply to a different service as an error", async () => {
    const [unit] = await session(fixed("5A86"), DiagProtocol.KWP2000);
    await expect(new Kwp2000(unit, 0x92).faults()).rejects.toThrow(/does not answer/);
  });

  it("cannot clear or write with a raw request", async () => {
    const [unit, core] = await session(
      new KwpEcu(0x785, [[0x5123, 0x61]]).respond,
      DiagProtocol.KWP2000,
    );
    for (const request of ["14FF00", "3101", "3B0100", "2701"]) {
      await expect(unit.request(fromHex(request))).rejects.toThrow(GuardError);
    }
    expect(core.requests).toEqual([]);
  });

  it("sends the clear with a token", async () => {
    const ecu = new KwpEcu(0x785, [[0x5123, 0x61]]);
    const [unit, core] = await session(ecu.respond, DiagProtocol.KWP2000);
    const store = new MemorySnapshotStore();
    store.write("snapshot.json", "{}");
    await new Kwp2000(unit, 0x92).clear(await authoriseClear(store, "snapshot.json"));
    expect(core.requests).toEqual(["14FF00"]);
    expect(ecu.faults).toEqual([]);
  });
});

describe("UDS", () => {
  const uds: Responder = (request) => {
    const replies = new Map([
      ["1003", "5003003201F4"],
      ["22F190", "62F190" + toHex(asciiEncode("WDB2110201A000001"))],
      ["22F187", "7F2231"],
      ["22F18C", "7F2231"],
      ["22F195", "62F1950102"],
      ["1902FF", "5902FF" + "C1234508" + "D0010009"],
      ["1904C12345FF", "5904C12345080101"],
      ["14FFFFFF", "54"],
    ]);
    const key = Array.from(request, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");
    const reply = replies.get(key);
    if (reply === undefined) throw new Error(`the scripted unit has no reply for ${key}`);
    return [[0x785, fromHex(reply)]];
  };

  it("reads identification, faults and freeze frames", async () => {
    const [unit, core] = await session(uds, DiagProtocol.UDS);
    const client = new Uds(unit, 0x03);
    await client.start();
    const fields = Object.fromEntries(
      (await client.identification()).map((item) => [item.label, item.text]),
    );
    expect(fields).toEqual({ VIN: "WDB2110201A000001", "software version": "" });
    const faults: Fault[] = [
      { code: "C12345", status: 0x08 },
      { code: "D00100", status: 0x09 },
    ];
    expect(await client.faults()).toEqual(faults);
    expect(await client.freezeFrame({ code: "C12345", status: 0x08 })).toEqual(
      fromHex("C12345080101"),
    );
    expect(core.requests[0]).toBe("1003");
  });

  it("reads a data identifier", async () => {
    const [unit] = await session(uds, DiagProtocol.UDS);
    expect(await new Uds(unit, 0x03).readValue(0xf195)).toEqual(fromHex("0102"));
    const [other] = await session(fixed("62F1960102"), DiagProtocol.UDS);
    await expect(new Uds(other, 0x03).readValue(0xf195)).rejects.toThrow(
      /does not answer data identifier F195/,
    );
  });

  it("treats a partial fault record as an error", async () => {
    const [unit] = await session(fixed("5902FFC12345"), DiagProtocol.UDS);
    await expect(new Uds(unit, 0x03).faults()).rejects.toThrow(ElmError);
  });

  it("sends the clear with a token", async () => {
    const [unit, core] = await session(uds, DiagProtocol.UDS);
    const store = new MemorySnapshotStore();
    store.write("snapshot.json", "{}");
    await new Uds(unit, 0x03).clear(await authoriseClear(store, "snapshot.json"));
    expect(core.requests).toEqual(["14FFFFFF"]);
  });
});

describe("OBD", () => {
  const replies = new Map<string, [number, string][]>([
    ["0902", [[0x7e8, `490201${toHex(asciiEncode("WDB2110200A000000"))}`]]],
    [
      "0101",
      [
        [0x7e8, "410182076500"],
        [0x7e9, "410100000000"],
      ],
    ],
    [
      "03",
      [
        [0x7e8, "430201230420"],
        [0x7e9, "4300"],
      ],
    ],
    ["07", [[0x7e8, "4700"]]],
    ["0A", []],
    ["010C", [[0x7e8, "410C0C80"]]],
    ["0105", [[0x7e8, "41055A"]]],
    ["0142", [[0x7e8, "41423070"]]],
  ]);

  function obdCar(request: Uint8Array): [number, Uint8Array][] {
    const found = replies.get(toUpperHex(request)) ?? [];
    return found.map(([sender, text]) => [sender, fromHex(text)]);
  }

  async function obdElm(): Promise<[Elm, FakeElmCore]> {
    const core = new FakeElmCore({ 0x7df: obdCar });
    const elm = new Elm(fakeTransport(core));
    await elm.selectCan(11, 500_000);
    await elm.addressFunctional(FUNCTIONAL_ID[11]);
    return [elm, core];
  }

  it("reads the VIN, readiness, codes and values", async () => {
    const [elm, core] = await obdElm();
    expect(core.sent.slice(1)).toEqual(["ATSH7DF", "ATAR", "ATFCSM0"]);
    expect(await vin(elm)).toBe("WDB2110200A000000");
    const state = await readiness(elm);
    expect(state.get(0x7e8)).toEqual({ lampOn: true, codeCount: 2 });
    expect(state.get(0x7e9)).toEqual({ lampOn: false, codeCount: 0 });
    expect(await codes(elm, STORED_CODES)).toEqual(
      new Map([
        [0x7e8, ["P0123", "P0420"]],
        [0x7e9, []],
      ]),
    );
    const pid = (code: number): NonNullable<ReturnType<typeof PIDS.get>> => {
      const found = PIDS.get(code);
      if (found === undefined) throw new Error(`no parameter ${String(code)}`);
      return found;
    };
    expect(await readPid(elm, pid(0x05))).toEqual(new Map([[0x7e8, [50]]]));
    expect(await readPid(elm, pid(0x0c))).toEqual(new Map([[0x7e8, [800]]]));
    expect(await readPid(elm, pid(0x42))).toEqual(new Map([[0x7e8, [12.4]]]));
  });

  it.each([
    ["0123", "P0123"],
    ["4321", "C0321"],
    ["9003", "B1003"],
    ["C100", "U0100"],
    ["3FFF", "P3FFF"],
  ])("decodes the code bytes %s as %s", (pair, code) => {
    expect(decodeCode(fromHex(pair))).toBe(code);
  });

  it("cannot clear without the clear command", async () => {
    const [elm, core] = await obdElm();
    await expect(readAnswers(elm, Uint8Array.of(0x04))).rejects.toThrow(GuardError);
    expect(core.requests).toEqual([]);
  });
});
