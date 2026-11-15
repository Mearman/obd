import { describe, expect, it } from "vitest";
import { EventLog, formatEvent, isOperationName, type AppEvent } from "../src/report/events";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

describe("EventLog", () => {
  it("keeps at most maxEvents, dropping the oldest", () => {
    const log = new EventLog({ maxEvents: 5 });
    for (let index = 0; index < 20; index += 1) {
      log.record({ kind: "operation", name: `op${String(index)}`, outcome: "ok" });
    }
    const names = log.snapshot().map((event) => (event.kind === "operation" ? event.name : ""));
    expect(names).toEqual(["op15", "op16", "op17", "op18", "op19"]);
  });

  it("keeps the kept events within maxBytes, and always the newest", () => {
    const log = new EventLog({ maxBytes: 300 });
    for (let index = 0; index < 100; index += 1) {
      log.record({ kind: "operation", name: `operation${String(index)}`, outcome: "ok" });
    }
    const kept = log.snapshot();
    expect(JSON.stringify(kept).length).toBeLessThan(600);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(100);
    expect(kept.at(-1)).toMatchObject({ name: "operation99" });
  });

  it("counts a repeat of the newest event instead of storing it again", () => {
    const log = new EventLog();
    const event: AppEvent = { kind: "operation", name: "runs.status", outcome: "ok" };
    log.record(event);
    log.record(event);
    log.record(event);
    log.record({ kind: "disconnect" });
    log.record(event);
    expect(log.snapshot().map((logged) => logged.count)).toEqual([3, 1, 1]);
  });

  it("stamps events with time since the start, to 100 ms", () => {
    const time = clock();
    const log = new EventLog({}, time.now);
    time.advance(1234);
    log.record({ kind: "screen", screen: "scan" });
    expect(log.snapshot()[0]?.at).toBe(1200);
  });

  it("drops an operation whose name is not a procedure path, so text cannot enter by it", () => {
    const log = new EventLog();
    for (const name of [
      "WDB2110202B121724",
      "scan run",
      "a.b.c.d.e",
      "/Users/me/file.json",
      "",
      "scan.Run",
    ]) {
      log.record({ kind: "operation", name, outcome: "ok" });
    }
    expect(log.snapshot()).toEqual([]);
    expect(isOperationName("scan.run")).toBe(true);
    expect(isOperationName("guarded.cancel")).toBe(true);
  });

  it("clears, and a snapshot is not changed by later events", () => {
    const log = new EventLog();
    log.record({ kind: "disconnect" });
    const before = log.snapshot();
    log.record({ kind: "screen", screen: "live" });
    expect(before).toHaveLength(1);
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });

  it("formats each kind as one line", () => {
    const events: readonly AppEvent[] = [
      { kind: "screen", screen: "runs" },
      { kind: "connect", transport: "webserial" },
      { kind: "disconnect" },
      { kind: "operation", name: "scan.run", outcome: "refused" },
      { kind: "storage", state: "ready" },
      { kind: "service-worker", state: "controlled" },
      { kind: "error", source: "react", screen: "scan" },
    ];
    expect(events.map((event) => formatEvent({ ...event, at: 1500, count: 2 }))).toEqual([
      "+1.5s screen runs x2",
      "+1.5s connect webserial x2",
      "+1.5s disconnect x2",
      "+1.5s operation scan.run refused x2",
      "+1.5s storage ready x2",
      "+1.5s service-worker controlled x2",
      "+1.5s error react on scan x2",
    ]);
  });
});
