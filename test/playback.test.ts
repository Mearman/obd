import { describe, expect, it } from "vitest";
import {
  MAX_GAP_MS,
  MIN_GAP_MS,
  buildTimeline,
  captureAsOf,
  countAt,
  decodeAsOf,
  decodeCapture,
  exchangeStatus,
  playbackStateAt,
  profileUnit,
  makeClient,
  scan,
  timeOfCount,
  type Capture,
  type Exchange,
} from "../src/core/index.js";
import { authored, record, shipped } from "./helpers/captures.js";

const W211 = shipped("mercedes-w211");
const TARGET = { kind: "profile", profile: W211 } as const;

/** The W211 engine with one invented record the capture reads, so decoded values exist to watch change. */
const RECORD = {
  kind: "profile",
  profile: authored({
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
        values: { record: { label: "invented record", identifier: 0x99, size: 2, source: "test" } },
      },
    },
  }),
} as const;

/** A scan of the simulated W211 plus a read of the engine's one invented record, one exchange every 500 ms. */
async function spaced(): Promise<Capture> {
  const capture = await record(W211, async (elm) => {
    await scan(elm, W211, { faults: true, freeze: false });
    const engine = profileUnit(W211, "engine");
    await elm.addressUnit(engine.requestId, engine.responseId);
    await makeClient(elm, W211, engine).readValue(0x99);
  });
  return {
    ...capture,
    exchanges: capture.exchanges.map((exchange, index) => ({
      ...exchange,
      at: capture.startedAt + index * 500,
    })),
  };
}

function withOutcome(exchange: Exchange, outcome: Exchange["outcome"]): Exchange {
  return { ...exchange, outcome };
}

describe("exchange status", () => {
  it("tells an answer from a refusal and from silence", async () => {
    const [first] = (await spaced()).exchanges;
    if (first === undefined) throw new Error("the capture is empty");
    const reply = (messages: string[]) =>
      withOutcome(first, { kind: "replies", replies: [{ sender: 0x7e8, messages }] });
    expect(exchangeStatus(reply(["5001"]))).toBe("answered");
    expect(exchangeStatus(reply(["7F2111"]))).toBe("negative");
    // A "response pending" refusal followed by the real answer is an answer.
    expect(exchangeStatus(reply(["7F2178", "6199"]))).toBe("answered");
    expect(exchangeStatus(withOutcome(first, { kind: "no-response", message: "NO DATA" }))).toBe(
      "unanswered",
    );
    expect(
      exchangeStatus(
        withOutcome(first, { kind: "transport-error", error: "TransportTimeout", message: "late" }),
      ),
    ).toBe("unanswered");
  });
});

describe("the timeline", () => {
  it("orders every exchange with its recorded and playback times", async () => {
    const capture = await spaced();
    const timeline = buildTimeline(capture);
    expect(timeline.entries).toHaveLength(capture.exchanges.length);
    expect(timeline.entries.map((entry) => entry.seq)).toEqual(
      capture.exchanges.map((exchange) => exchange.seq),
    );
    expect(timeline.entries[0]).toMatchObject({ offsetMs: 0, t: 0 });
    expect(timeline.entries[3]).toMatchObject({ offsetMs: 1500, t: 1500 });
    expect(timeline.duration).toBe(timeline.entries.at(-1)?.t);
  });

  it("clamps the gaps so an instant burst is watchable and a long pause is short", async () => {
    const base = await spaced();
    const [a, b, c, d] = base.exchanges;
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      throw new Error("the capture is too short");
    }
    const timeline = buildTimeline({
      ...base,
      exchanges: [
        a,
        { ...b, at: a.at },
        { ...c, at: a.at + 3_600_000 },
        { ...d, at: a.at + 3_600_100 },
      ],
    });
    expect(timeline.entries.map((entry) => entry.t)).toEqual([
      0,
      MIN_GAP_MS,
      MIN_GAP_MS + MAX_GAP_MS,
      MIN_GAP_MS + MAX_GAP_MS + MIN_GAP_MS,
    ]);
    expect(timeline.entries[2]?.offsetMs).toBe(3_600_000);
  });

  it("has no entries and no duration for an empty capture", async () => {
    const base = await spaced();
    expect(buildTimeline({ ...base, exchanges: [] })).toEqual({ entries: [], duration: 0 });
  });

  it("counts the exchanges at or before a time and gives the time back", async () => {
    const timeline = buildTimeline(await spaced());
    expect(countAt(timeline, -1)).toBe(0);
    expect(countAt(timeline, 0)).toBe(1);
    expect(countAt(timeline, 499)).toBe(1);
    expect(countAt(timeline, 500)).toBe(2);
    expect(countAt(timeline, timeline.duration)).toBe(timeline.entries.length);
    expect(countAt(timeline, timeline.duration + 1e9)).toBe(timeline.entries.length);
    expect(timeOfCount(timeline, 0)).toBe(0);
    expect(timeOfCount(timeline, 3)).toBe(1000);
    expect(timeOfCount(timeline, 1e6)).toBe(timeline.duration);
  });
});

describe("a capture as of a cursor", () => {
  it("decodes exactly what the whole capture decodes to once the cursor is at the end", async () => {
    const capture = await spaced();
    const timeline = buildTimeline(capture);
    const state = await playbackStateAt(capture, timeline, TARGET, timeline.duration);
    expect(state.exchanges).toEqual(capture.exchanges);
    expect(state.decoded).toEqual(await decodeCapture(capture, TARGET));
  });

  it("holds nothing before the first exchange and only what has happened part-way", async () => {
    const capture = await spaced();
    const timeline = buildTimeline(capture);
    const start = await playbackStateAt(capture, timeline, TARGET, -1);
    expect(start.count).toBe(0);
    expect(start.exchanges).toEqual([]);
    expect(start.decoded.units.every((unit) => !unit.answered)).toBe(true);
    expect(start.decoded.values).toEqual([]);

    const engineRead = capture.exchanges.findIndex((exchange) => exchange.request === "2199");
    expect(engineRead).toBeGreaterThan(0);
    const before = await decodeAsOf(capture, RECORD, engineRead);
    const after = await decodeAsOf(capture, RECORD, engineRead + 1);
    expect(before.values).toEqual([]);
    expect(after.values.map((value) => value.seq)).toEqual([capture.exchanges[engineRead]?.seq]);
    expect(before.exchanges).toBe(engineRead);
  });

  it("shows the latest read of a repeated request, not the first", async () => {
    const capture = await spaced();
    const index = capture.exchanges.findIndex((exchange) => exchange.request === "2199");
    const read = capture.exchanges[index];
    if (read === undefined) throw new Error("the capture holds no read");
    const later: Exchange = {
      ...read,
      seq: capture.exchanges.length,
      at: read.at + 60_000,
      outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: ["61990002"] }] },
    };
    const longer = { ...capture, exchanges: [...capture.exchanges, later] };
    const first = await decodeAsOf(longer, RECORD, longer.exchanges.length - 1);
    const last = await decodeAsOf(longer, RECORD, longer.exchanges.length);
    expect(first.values[0]?.seq).toBe(read.seq);
    expect(last.values[0]?.seq).toBe(later.seq);
    expect(last.values[0]?.value).not.toEqual(first.values[0]?.value);
    expect(last.exchanges).toBe(longer.exchanges.length);
    // Every exchange so far is still listed even though the decoder read only the latest of each request.
    expect(captureAsOf(longer, longer.exchanges.length).exchanges).toHaveLength(
      longer.exchanges.length,
    );
  });

  it("decodes under no profile too", async () => {
    const capture = await spaced();
    const generic = await decodeAsOf(capture, { kind: "generic" }, 2);
    expect(generic.units).toEqual([]);
    expect(generic.exchanges).toBe(2);
  });
});
