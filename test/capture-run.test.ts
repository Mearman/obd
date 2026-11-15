import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  GuardError,
  READ_ONLY,
  captureEverything,
  decodeCapture,
  discoveryRangeSchema,
  identifierSweepSchema,
  parseCapture,
  parseProfile,
  captureText,
  scan,
  type CaptureProgress,
  type CaptureRunOptions,
  type FakeElmCore,
  type Profile,
} from "../src/core/index.js";
import { shipped, simulatedSession } from "./helpers/captures.js";
import { MINIMAL, edit } from "./support/profiles.js";

const W211 = shipped("mercedes-w211");
const MQB = shipped("vag-mqb");
const BMW = shipped("bmw-f-fem");

/** Every service that changes a car or opens access: none may appear in a capture. */
const CHANGING_SERVICES = [0x04, 0x11, 0x14, 0x27, 0x28, 0x2e, 0x2f, 0x30, 0x31, 0x3b, 0x85];

/** Runs a capture on a fresh simulated car for `car` and returns it with the requests the car saw. */
async function capture(
  car: Profile,
  options: Partial<CaptureRunOptions> = {},
): Promise<{
  readonly result: Awaited<ReturnType<typeof captureEverything>>;
  readonly core: FakeElmCore;
}> {
  const { elm, car: core, adapter } = await simulatedSession(car);
  const result = await captureEverything(elm, {
    profile: car,
    adapter,
    adapterUrl: "simulator://test",
    toolVersion: "test",
    id: "capture-test",
    now: () => 1_000,
    sleep: () => Promise.resolve(),
    ...options,
  });
  return { result, core };
}

/** The diagnostic requests a fake adapter was sent, without its own commands. */
function requestsSeen(core: FakeElmCore): string[] {
  return core.sent.filter((line) => !line.startsWith("AT") && !line.startsWith("ST"));
}

describe("captureEverything with a profile", () => {
  it("reads the legislated services and every unit, and decodes to the scan", async () => {
    const { result } = await capture(W211);
    expect(result.origin).toEqual({
      kind: "capture",
      profile: "mercedes-w211",
      complete: true,
      description: "legislated reads, unit reads of mercedes-w211",
    });
    expect(result.sessions[0]?.tool).toEqual({ name: "obd-read", version: "test" });
    expect(result.sessions[0]?.adapter.url).toBe("simulator://test");
    const decoded = await decodeCapture(result, { kind: "profile", profile: W211 });
    const { elm } = await simulatedSession(W211);
    expect(decoded.units).toEqual(await scan(elm, W211, { faults: true, freeze: true }));
    expect(decoded.obd?.vin).toBe("SIMULATEDCAR00001");
    expect(parseCapture(captureText(result), "x")).toEqual(result);
  });

  it("records every request the car was sent", async () => {
    const { result, core } = await capture(W211);
    expect(result.exchanges.map((exchange) => exchange.request)).toEqual(requestsSeen(core));
  });

  it("reaches units with an extended address", async () => {
    const { result } = await capture(BMW);
    const dme = result.exchanges.filter(
      (exchange) => exchange.address?.mode === "physical" && exchange.address.responseId === 0x612,
    );
    expect(dme[0]?.address).toEqual({
      mode: "physical",
      requestId: 0x6f1,
      responseId: 0x612,
      extendedAddress: 0x12,
    });
    const decoded = await decodeCapture(result, { kind: "profile", profile: BMW });
    expect(decoded.units.find((unit) => unit.unit === "dme")?.faults).toEqual([
      { code: "C12345", status: "08" },
    ]);
  });
});

describe("captureEverything with no profile", () => {
  it("finds units with a bounded sweep and reads them, so a profile decodes them later", async () => {
    const { result } = await capture(W211, {
      profile: undefined,
      discovery: { first: 0x7e0, last: 0x7e1, protocols: [DiagProtocol.KWP2000] },
    });
    expect(result.origin.profile).toBeNull();
    const sweepRequests = result.exchanges.filter(
      (exchange) => exchange.address?.mode === "any-reply",
    );
    expect(sweepRequests.map((exchange) => exchange.request)).toEqual(["1081", "1081"]);
    const decoded = await decodeCapture(result, { kind: "profile", profile: W211 });
    expect(decoded.units.find((unit) => unit.unit === "engine")?.faults).toEqual([
      { code: "1234", status: "20" },
    ]);
    expect(decoded.units.find((unit) => unit.unit === "esp")?.notes).toEqual([
      "not in this capture",
    ]);
    expect(decoded.discovered.map((found) => found.responseId)).toEqual([0x7e8, 0x7e9]);
    const generic = await decodeCapture(result, { kind: "generic" });
    expect(generic.undecoded.some((exchange) => exchange.request === "1802FF00")).toBe(true);
  });

  it("refuses a discovery range outside 11-bit CAN or turned round", () => {
    expect(
      discoveryRangeSchema.safeParse({ first: 0x700, last: 0x800, protocols: ["uds"] }).success,
    ).toBe(false);
    expect(
      discoveryRangeSchema.safeParse({ first: 0x7ff, last: 0x700, protocols: ["uds"] }).success,
    ).toBe(false);
    expect(
      discoveryRangeSchema.safeParse({ first: 0x700, last: 0x7ff, protocols: ["obd"] }).success,
    ).toBe(false);
  });
});

describe("the guard during a capture", () => {
  it.each([
    ["kwp2000", W211],
    ["uds", MQB],
  ])("sends only read-only services on %s, identifier sweep included", async (_label, car) => {
    const { result, core } = await capture(car, {
      identifiers: { first: 0x00, last: 0x0f, budget: 1000, pauseMs: 10 },
    });
    expect(result.exchanges.length).toBeGreaterThan(0);
    for (const exchange of result.exchanges) {
      const service = Number.parseInt(exchange.request.slice(0, 2), 16);
      expect(exchange.protocol).not.toBeNull();
      if (exchange.protocol === null) continue;
      expect(READ_ONLY[exchange.protocol].has(service)).toBe(true);
      expect(CHANGING_SERVICES).not.toContain(service);
    }
    expect(result.exchanges.map((exchange) => exchange.request)).toEqual(requestsSeen(core));
  });

  it("refuses a profile whose session the guard does not allow", async () => {
    // Each unit carries its own session, so the refused one is set on every unit.
    const programming: Profile = {
      ...W211,
      units: new Map([...W211.units].map(([name, unit]) => [name, { ...unit, session: 0x85 }])),
    };
    await expect(capture(programming)).rejects.toThrow(GuardError);
  });

  it.each([
    ["a service to sweep", { first: 0, last: 1, budget: 1, pauseMs: 10, service: 0x2e }],
    ["a budget over the limit", { first: 0, last: 1, budget: 20_001, pauseMs: 10 }],
    ["no pause", { first: 0, last: 1, budget: 1, pauseMs: 0 }],
    ["a turned-round range", { first: 2, last: 1, budget: 1, pauseMs: 10 }],
    ["a three-byte identifier", { first: 0, last: 0x10000, budget: 1, pauseMs: 10 }],
  ])("refuses an identifier sweep with %s", (_label, sweep) => {
    expect(identifierSweepSchema.safeParse(sweep).success).toBe(false);
  });
});

describe("the identifier sweep", () => {
  it("stops at its budget, pausing before every request", async () => {
    const pauses: number[] = [];
    const { result } = await capture(W211, {
      identifiers: { first: 0x00, last: 0xff, budget: 5, pauseMs: 75 },
      sleep: (milliseconds) => {
        pauses.push(milliseconds);
        return Promise.resolve();
      },
    });
    const reads = result.exchanges.filter((exchange) => exchange.request.startsWith("21"));
    expect(reads.map((exchange) => exchange.request)).toEqual([
      "2100",
      "2101",
      "2102",
      "2103",
      "2104",
    ]);
    expect(pauses).toEqual([75, 75, 75, 75, 75]);
    expect(result.notes).toContain("identifier sweep stopped at its budget of 5 requests");
    expect(result.origin.complete).toBe(true);
  });

  it("keeps refusals and unknown identifiers raw for a later profile", async () => {
    const { result } = await capture(MQB, {
      identifiers: { first: 0x0198, last: 0x019a, budget: 100, pauseMs: 10 },
    });
    const engine = result.exchanges.filter(
      (exchange) =>
        ["220198", "220199", "22019A"].includes(exchange.request) &&
        exchange.address?.mode === "physical" &&
        exchange.address.requestId === 0x7e0,
    );
    expect(engine.map((exchange) => exchange.outcome)).toEqual([
      { kind: "replies", replies: [{ sender: 0x7e8, messages: ["7F2231"] }] },
      { kind: "replies", replies: [{ sender: 0x7e8, messages: ["6201990001"] }] },
      { kind: "replies", replies: [{ sender: 0x7e8, messages: ["7F2231"] }] },
    ]);
    const decoded = await decodeCapture(result, { kind: "profile", profile: MQB });
    expect(decoded.undecoded.filter((exchange) => exchange.request === "220199")).toHaveLength(
      MQB.units.size,
    );
  });

  it("sweeps each unit with its own protocol's read service", async () => {
    const mixed = parseProfile(
      edit(MINIMAL, ["units"], {
        kwp: {
          description: "KWP2000 unit",
          request: 0x7e0,
          response: 0x7e8,
          diagnostics: { protocol: "kwp2000", session: 0x92 },
          source: "test",
        },
        uds: {
          description: "UDS unit",
          request: 0x7e1,
          response: 0x7e9,
          diagnostics: { protocol: "uds", session: 0x01 },
          source: "test",
        },
      }),
      "mixed",
    );
    const { result } = await capture(mixed, {
      identifiers: { first: 0x99, last: 0x99, budget: 10, pauseMs: 10 },
    });
    const reads = result.exchanges
      .filter((exchange) => ["2199", "220099"].includes(exchange.request))
      .map((exchange) => [exchange.protocol, exchange.request]);
    expect(reads).toEqual([
      ["kwp2000", "2199"],
      ["uds", "220099"],
    ]);
  });

  it("stops when asked, mid-sweep, and says the capture is incomplete", async () => {
    let sweeping = false;
    let asked = 0;
    const { result, core } = await capture(W211, {
      identifiers: { first: 0x00, last: 0xff, budget: 1000, pauseMs: 10 },
      progress: (event: CaptureProgress) => {
        if (event.step === "identifiers") sweeping = true;
      },
      stopped: () => {
        if (sweeping) asked += 1;
        return asked > 2;
      },
    });
    expect(result.origin.complete).toBe(false);
    expect(result.notes).toContain("stopped before it finished");
    expect(
      result.exchanges
        .filter((exchange) => exchange.request.startsWith("21"))
        .map((exchange) => exchange.request),
    ).toEqual(["2100", "2101"]);
    expect(result.exchanges.map((exchange) => exchange.request)).toEqual(requestsSeen(core));
  });
});
