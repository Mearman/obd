import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Elm,
  FUNCTIONAL_ID,
  ImportError,
  decodeCapture,
  importSavedScan,
  importTranscript,
  obdReport,
  scanDocument,
  scan,
  jsonText,
  Transcript,
  selectBus,
  adapterTransport,
  simulatedCar,
} from "../src/core/index.js";
import { FakeElmCore, fakeTransport } from "./helpers/fake-elm.js";
import { shipped } from "./helpers/captures.js";
import { loadReplies, responder } from "./helpers/transcripts.js";

const FIXTURES = new URL("fixtures/", import.meta.url);
const RECORDED = ["a150-modes-01-to-09.txt", "a150-since-clear.txt"];
const W211 = shipped("mercedes-w211");

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(name, FIXTURES), "utf8").split("\n");
}

/** What the `obd` report prints for a car answering from the recorded replies. */
async function recordedObdLines(): Promise<string[]> {
  const elm = new Elm(
    fakeTransport(new FakeElmCore({ 0x7df: responder(loadReplies(...RECORDED)) })),
  );
  await elm.selectCan(11, 500_000);
  await elm.addressFunctional(FUNCTIONAL_ID[11]);
  const lines: string[] = [];
  await obdReport(elm, (line) => lines.push(line));
  return lines;
}

describe("importing the recorded A 150 transcripts", () => {
  it.each(RECORDED)("recovers every request of %s", (name) => {
    const lines = fixtureLines(name);
    const { capture, unrecovered } = importTranscript(lines, {
      id: "a150",
      description: `transcript ${name}`,
      profile: null,
    });
    expect(unrecovered).toEqual([]);
    const requests = lines
      .map((line) => line.split(" "))
      .filter(
        ([, direction, text]) => direction === ">" && text !== undefined && !/^(AT|ST)/.test(text),
      )
      .map(([, , text]) => text);
    expect(capture.exchanges.map((exchange) => exchange.request)).toEqual(requests);
    expect(capture.sessions).toHaveLength(1);
    const [session] = capture.sessions;
    expect(session?.adapter.voltage).toMatch(/^14\.\dV$/);
    expect({ ...session?.adapter, voltage: null }).toEqual({
      url: null,
      identity: "ELM327 v1.5",
      description: "OBDII to RS232 Interpreter",
      stnIdentity: null,
      voltage: null,
      hasStnExtensions: false,
    });
    expect(session?.tool).toEqual({ name: "obd-read", version: "unknown" });
    for (const exchange of capture.exchanges) {
      expect(exchange.address).toEqual({ mode: "functional", requestId: 0x7df });
      expect(exchange.bus).toEqual({ kind: "can", idBits: 11, bitrate: null });
    }
    expect(capture.origin).toEqual({
      kind: "import",
      profile: null,
      complete: true,
      description: `transcript ${name}`,
    });
  });

  it("keeps a no-data reply and a multi-frame reply raw", () => {
    const { capture } = importTranscript(fixtureLines(RECORDED[0] ?? ""), {
      id: "a150",
      description: "a150",
      profile: null,
    });
    expect(capture.exchanges.find((exchange) => exchange.request === "0110")?.outcome).toEqual({
      kind: "no-response",
      message: "no control unit answered",
    });
    expect(capture.exchanges.find((exchange) => exchange.request === "06A1")?.outcome).toEqual({
      kind: "replies",
      replies: [{ sender: 0x7e8, messages: ["46A10C240004" + "0000FFFF"] }],
    });
  });

  it("decodes with no profile to what the obd report prints for the recorded car", async () => {
    const both = RECORDED.flatMap(fixtureLines);
    const { capture } = importTranscript(both, { id: "a150", description: "both", profile: null });
    const decoded = await decodeCapture(capture, { kind: "generic" });
    expect(decoded.obdLines).toEqual(await recordedObdLines());
    expect(decoded.obd?.units.map((unit) => unit.sender)).toEqual(["7E8"]);
  });

  it("starts a new adapter session at each reset", () => {
    const both = RECORDED.flatMap(fixtureLines);
    const { capture } = importTranscript(both, { id: "a150", description: "both", profile: null });
    expect(capture.sessions).toHaveLength(2);
    expect(capture.exchanges.at(-1)?.session).toBe(1);
    expect(capture.exchanges[0]?.session).toBe(0);
  });
});

describe("importing other transcripts", () => {
  it("follows physical addressing, the receive filter and the extended address", () => {
    const lines = [
      "2026-01-02T03:04:05.000+00:00 > ATSP6",
      "2026-01-02T03:04:05.000+00:00 < OK",
      "2026-01-02T03:04:05.000+00:00 > ATSH6F1",
      "2026-01-02T03:04:05.000+00:00 < OK",
      "2026-01-02T03:04:05.000+00:00 > ATCRA612",
      "2026-01-02T03:04:05.000+00:00 < OK",
      "2026-01-02T03:04:05.000+00:00 > ATCEA12",
      "2026-01-02T03:04:05.000+00:00 < OK",
      "2026-01-02T03:04:05.100+00:00 > 22F190",
      "2026-01-02T03:04:05.150+00:00 < 612 F1 03 7F 22 31",
      "2026-01-02T03:04:05.200+00:00 > ATCEA",
      "2026-01-02T03:04:05.200+00:00 < OK",
      "2026-01-02T03:04:05.300+00:00 > 1A86",
      "2026-01-02T03:04:05.350+00:00 < ?",
    ];
    const { capture, unrecovered } = importTranscript(lines, {
      id: "x",
      description: "x",
      profile: null,
    });
    expect(unrecovered).toEqual([]);
    expect(capture.exchanges).toEqual([
      {
        seq: 0,
        at: Date.parse("2026-01-02T03:04:05.100Z"),
        session: 0,
        bus: { kind: "can", idBits: 11, bitrate: 500_000 },
        address: { mode: "physical", requestId: 0x6f1, responseId: 0x612, extendedAddress: 0x12 },
        protocol: null,
        request: "22F190",
        outcome: { kind: "replies", replies: [{ sender: 0x612, messages: ["7F2231"] }] },
      },
      expect.objectContaining({
        request: "1A86",
        address: { mode: "physical", requestId: 0x6f1, responseId: 0x612, extendedAddress: null },
        outcome: {
          kind: "adapter-error",
          error: "ElmError",
          message: "the adapter did not understand 1A86",
        },
      }),
    ]);
  });

  it("lists what it cannot recover instead of guessing", () => {
    const lines = [
      "not a transcript line",
      "2026-01-02T03:04:05.000+00:00 < 7E8 03 41 0D 00",
      "2026-01-02T03:04:05.000+00:00 > hello",
      "yesterday > 0100",
      "2026-01-02T03:04:06.000+00:00 > ATSP4",
      "2026-01-02T03:04:06.000+00:00 > 0100",
      "2026-01-02T03:04:06.000+00:00 < 48 6B 10 41 00 BE 3E B8 13 AA",
    ];
    const { capture, unrecovered } = importTranscript(lines, {
      id: "x",
      description: "x",
      profile: null,
    });
    expect(capture.exchanges).toEqual([]);
    expect(capture.origin.complete).toBe(false);
    expect(unrecovered).toEqual([
      "line 1: not a transcript line",
      "line 2: a received line with no request before it",
      'line 3: "hello" is not a diagnostic request',
      "line 4: the request's time cannot be read",
      "line 6: K-line requests are not recovered; their reply lines carry K-line framing this importer does not read",
    ]);
    expect(capture.notes).toEqual(unrecovered);
  });
});

describe("importing a saved scan", () => {
  async function savedScanText(): Promise<string> {
    const transcript = new Transcript();
    const elm = new Elm(adapterTransport(simulatedCar(W211)), { transcript });
    const adapter = await elm.initialise();
    await selectBus(elm, W211);
    const units = await scan(elm, W211, { faults: true, freeze: true });
    return jsonText(scanDocument(W211, adapter, units, transcript.entries).json);
  }

  it("recovers the exchanges from its transcript and decodes them to its units", async () => {
    const text = await savedScanText();
    const { capture, unrecovered } = importSavedScan(text, "imported", "scan.json");
    expect(unrecovered).toEqual([]);
    expect(capture.origin).toMatchObject({ kind: "import", profile: "mercedes-w211" });
    const decoded = await decodeCapture(capture, { kind: "profile", profile: W211 });
    const { elm } = await (async () => {
      const live = new Elm(adapterTransport(simulatedCar(W211)));
      await live.initialise();
      await selectBus(live, W211);
      return { elm: live };
    })();
    expect(decoded.units).toEqual(await scan(elm, W211, { faults: true, freeze: true }));
    expect(decoded.undecoded).toEqual([]);
  });

  it("says when a saved scan has no transcript", async () => {
    const data: unknown = JSON.parse(await savedScanText());
    const text = JSON.stringify({ ...(typeof data === "object" ? data : {}), transcript: [] });
    const { capture, unrecovered } = importSavedScan(text, "imported", "old.json");
    expect(capture.exchanges).toEqual([]);
    expect(unrecovered).toEqual([
      "the saved scan has no transcript, so its requests and raw replies cannot be recovered; its decoded units stay in the scan file",
    ]);
  });

  it.each([
    ["not JSON", "{"],
    ["another tool's file", '{"tool":"other"}'],
    ["an array", "[]"],
  ])("refuses %s", (_label, text) => {
    expect(() => importSavedScan(text, "x", "x.json")).toThrow(ImportError);
  });
});
