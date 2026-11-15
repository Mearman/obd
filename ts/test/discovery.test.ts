import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  OptionError,
  checkProfileText,
  discoverCommand,
  draftProfile,
  interpret,
  parseProfileText,
  printAdapter,
  profileUnit,
  reportCommandError,
  type DiscoverOptions,
  type Found,
} from "../src/core/index.js";
import { FakeElmCore, KwpEcu, fakeTransport, type Responder } from "./helpers/fake-elm.js";
import { WritableMemoryStore } from "./helpers/unit-rig.js";

/** A fake W211 with an engine unit and an ESP unit, and a record of what was said. */
class Car {
  readonly core = new FakeElmCore({
    0x7e0: new KwpEcu(0x7e8, []).respond,
    0x784: new KwpEcu(0x785, [
      [0x5123, 0x61],
      [0x9003, 0x20],
    ]).respond,
  });
  readonly transport = fakeTransport(this.core);
  readonly store = new WritableMemoryStore();
  lines: string[] = [];

  /** Runs the sweep command on a fresh session and returns its exit status. */
  async run(options: Partial<DiscoverOptions> = {}): Promise<number> {
    this.lines = [];
    const out = (line: string): void => {
      this.lines.push(line);
    };
    await this.transport.open();
    try {
      const elm = new Elm(this.transport);
      printAdapter(await elm.initialise(), out);
      return await discoverCommand(
        elm,
        {
          protocol: DiagProtocol.KWP2000,
          bitrate: 500_000,
          first: 0x700,
          last: 0x7ff,
          name: "discovered",
          store: this.store,
          today: "2026-01-02",
          ...options,
        },
        out,
      );
    } catch (error) {
      return reportCommandError(error, out);
    } finally {
      await this.transport.close();
    }
  }

  get output(): string {
    return this.lines.join("\n");
  }
}

describe("the sweep", () => {
  it("lists units that answer and where from", async () => {
    const car = new Car();
    expect(await car.run({ first: 0x780, last: 0x7ff })).toBe(0);
    expect(car.output).toContain("request 0x784 -> response 0x785: session accepted");
    expect(car.output).toContain("request 0x7e0 -> response 0x7e8: session accepted");
    expect(car.output).toContain("2 replies in 128 identifiers");
    expect(car.output).toContain(
      "sweeping request identifiers 0x780 to 0x7ff with kwp2000 session 0x81; " +
        "each silent identifier waits out the adapter's reply timeout",
    );
  });

  it("sends only the guarded default session request", async () => {
    const car = new Car();
    expect(await car.run({ first: 0x780, last: 0x788 })).toBe(0);
    expect(new Set(car.core.requests)).toEqual(new Set(["1081"]));
    expect(car.core.requests).toHaveLength(9);
    expect(car.core.sent).toContain("ATSH784");
  });

  it("uses the UDS default session for a UDS sweep", async () => {
    const car = new Car();
    car.core.responders = {
      0x7e0: (request) => [[0x7e8, Uint8Array.of(0x50, request[1] ?? 0, 0, 0x32, 1, 0xf4)]],
    };
    expect(await car.run({ protocol: DiagProtocol.UDS, first: 0x7e0, last: 0x7e1 })).toBe(0);
    expect(new Set(car.core.requests)).toEqual(new Set(["1001"]));
  });

  it("counts a refused session as a unit and ignores other traffic", async () => {
    const car = new Car();
    const refuse: Responder = () => [[0x708, Uint8Array.of(0x7f, 0x10, 0x11)]];
    const unrelated: Responder = () => [[0x1c, Uint8Array.of(0x62, 0x01, 0x02)]];
    car.core.responders = { 0x700: refuse, 0x701: unrelated };
    expect(await car.run({ first: 0x700, last: 0x702 })).toBe(0);
    expect(car.output).toContain("request 0x700 -> response 0x708: session refused (11)");
    expect(car.output.replace("0x700 to 0x702", "")).not.toContain("0x701");
  });

  it("exits non-zero when nothing answers", async () => {
    const car = new Car();
    expect(await car.run({ first: 0x100, last: 0x102 })).toBe(1);
    expect(car.output).toContain("0 replies in 3 identifiers");
  });
});

describe("the draft profile", () => {
  it("passes the check and loads", async () => {
    const car = new Car();
    expect(await car.run({ first: 0x780, last: 0x7ff, output: "draft.json", name: "my-car" })).toBe(
      0,
    );
    const text = await car.store.readText("draft.json");
    expect(checkProfileText(text, "draft")).toEqual([]);
    const profile = parseProfileText(text, "draft");
    expect([profile.name, profile.status]).toEqual(["my-car", "unconfirmed"]);
    const unit = profileUnit(profile, "unit-784");
    expect([unit.requestId, unit.responseId]).toEqual([0x784, 0x785]);
    expect(unit.source).toContain("discover sweep");
    expect(car.lines.at(-1)).toBe(
      "wrote draft profile draft.json; check it with: obd-read profile check draft.json",
    );
  });

  it("is not written over an existing file", async () => {
    const car = new Car();
    car.store.write("draft.json", "keep me");
    expect(await car.run({ output: "draft.json" })).toBe(1);
    expect(await car.store.readText("draft.json")).toBe("keep me");
    expect(car.core.requests).toEqual([]);
    expect(car.core.sent.some((line) => line.startsWith("ATSH"))).toBe(false);
  });

  it.each([
    [0x7ff, 0x700],
    [0x700, 0x800],
  ])("refuses the range %i to %i before anything is sent", async (first, last) => {
    const car = new Car();
    expect(await car.run({ first, last })).toBe(1);
    expect(car.core.requests).toEqual([]);
    expect(car.core.sent.some((line) => line.startsWith("ATSH"))).toBe(false);
  });

  it("sends nothing for a session the guard refuses", async () => {
    const car = new Car();
    expect(await car.run({ session: 0x85, first: 0x700, last: 0x701 })).toBe(1);
    expect(car.core.requests).toEqual([]);
    expect(car.lines.at(-1)?.startsWith("error:")).toBe(true);
  });

  it("needs a valid name and distinct identifiers", () => {
    const unit: Found = {
      requestId: 0x7e0,
      responseId: 0x7e8,
      accepted: true,
      detail: "session accepted",
    };
    expect(() =>
      draftProfile([unit], "My Car", DiagProtocol.KWP2000, 0x81, 500_000, "2026-01-02"),
    ).toThrow(/lower-case/);
    const twin: Found = { ...unit, requestId: 0x7e1 };
    expect(() =>
      draftProfile([unit, twin], "car", DiagProtocol.KWP2000, 0x81, 500_000, "2026-01-02"),
    ).toThrow(/cannot be told apart/);
    expect(() =>
      draftProfile([unit], "My Car", DiagProtocol.KWP2000, 0x81, 500_000, "2026-01-02"),
    ).toThrow(OptionError);
  });
});

describe("interpret", () => {
  it("does not treat unrelated frames as units", () => {
    expect(
      interpret(
        new Map([
          [0x1c, [Uint8Array.of(0x62, 0x01)]],
          [0x7e8, [Uint8Array.of(0x50, 0x81)]],
        ]),
        0x7e0,
      ),
    ).toEqual([
      { requestId: 0x7e0, responseId: 0x7e8, accepted: true, detail: "session accepted" },
    ]);
  });
});
