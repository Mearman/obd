import { describe, expect, it } from "vitest";
import {
  Elm,
  OptionError,
  ProfileError,
  byteAt,
  fromHex,
  liveCommand,
  splitNames,
  parseProfile,
  type LiveOptions,
  type Profile,
} from "../src/core/index.js";
import { FakeElmCore, KwpEcu, UdsEcu, fakeTransport, type Responder } from "./helpers/fake-elm.js";
import { MemoryCsv } from "./helpers/memory-csv.js";
import { loadReplies, responder } from "./helpers/transcripts.js";
import { KWP_PROFILE, edit } from "./support/profiles.js";

const RECORDED = ["a150-modes-01-to-09.txt", "a150-since-clear.txt"];

const KWP = parseProfile(KWP_PROFILE, "test");
const UDS = parseProfile(
  edit(
    edit(edit(KWP_PROFILE, ["diagnostics", "protocol"], "uds"), ["diagnostics", "session"], 0x03),
    ["units", "engine", "values", "boost", "identifier"],
    0xf410,
  ),
  "test",
);

/** A KWP2000 unit that also answers service 21 for two identifiers and refuses the rest. */
function valueKwp(ecu: KwpEcu): Responder {
  return (request) => {
    if (request[0] !== 0x21) return ecu.respond(request);
    const identifier = byteAt(request, 1);
    const data = identifier === 0x10 ? "000A28" : identifier === 0x11 ? "FB" : undefined;
    return [
      [
        0x7e8,
        data === undefined
          ? Uint8Array.of(0x7f, 0x21, 0x31)
          : Uint8Array.of(0x61, identifier, ...fromHex(data)),
      ],
    ];
  };
}

function valueUds(ecu: UdsEcu): Responder {
  return (request) =>
    request[0] === 0x22 && request[1] === 0xf4 && request[2] === 0x10
      ? [[0x7e8, fromHex("62F410000A28")]]
      : ecu.respond(request);
}

class Rig {
  readonly lines: string[] = [];
  readonly csv = new MemoryCsv();
  private readonly elm: Elm;

  constructor(readonly core: FakeElmCore) {
    this.elm = new Elm(fakeTransport(core));
  }

  run(source: Profile | undefined, options: Partial<LiveOptions> = {}): Promise<number> {
    return liveCommand(
      this.elm,
      source,
      {
        idBits: 11,
        bitrate: 500_000,
        values: [],
        count: 1,
        intervalMs: 0,
        list: false,
        ...options,
      },
      (line) => this.lines.push(line),
    );
  }

  get output(): string {
    return this.lines.join("\n");
  }
}

function kwpRig(): Rig {
  return new Rig(new FakeElmCore({ 0x7e0: valueKwp(new KwpEcu(0x7e8, [])) }));
}

function recordedRig(): Rig {
  return new Rig(new FakeElmCore({ 0x7df: responder(loadReplies(...RECORDED)) }));
}

describe("a unit's profile values", () => {
  it("are read by name and logged", async () => {
    const rig = kwpRig();
    expect(
      await rig.run(KWP, {
        unit: "engine",
        values: ["boost", "rail-temperature"],
        count: 3,
        openLog: rig.csv.open,
      }),
    ).toBe(0);
    expect(rig.output).toContain("boost pressure: 260 kPa");
    expect(rig.output).toContain("rail temperature: -45 °C");
    expect(rig.output).toContain("sample 3 at");
    expect(rig.csv.rows[0]).toEqual([
      "time",
      "elapsed (s)",
      "boost pressure (kPa)",
      "rail temperature (°C)",
    ]);
    expect(rig.csv.rows).toHaveLength(4);
    expect(rig.csv.rows[1]?.slice(2)).toEqual(["260", "-45"]);
    expect(rig.core.requests.filter((request) => request === "2110")).toHaveLength(3);
    expect(rig.core.requests).toContain("2111");
    expect(rig.core.requests).not.toContain("217F");
  });

  it("flag unconfirmed identifiers", async () => {
    const rig = kwpRig();
    await rig.run(KWP, { unit: "engine", values: ["boost", "rail-temperature"] });
    expect(rig.output).toContain(
      "unconfirmed identifiers, check against the car: rail-temperature",
    );
  });

  it("report a refused value once and log it empty", async () => {
    const rig = kwpRig();
    await rig.run(KWP, {
      unit: "engine",
      values: ["boost", "refused"],
      count: 2,
      openLog: rig.csv.open,
    });
    expect(rig.output.split("refused not read")).toHaveLength(2);
    expect(rig.output).toContain("refused value: not read");
    expect(rig.csv.rows[1]?.slice(2)).toEqual(["260", ""]);
  });

  it("report a reply too short for the value as not read", async () => {
    const rig = new Rig(
      new FakeElmCore({
        0x7e0: (request) => [
          [
            0x7e8,
            request[0] === 0x10 ? Uint8Array.of(0x50, 0x92) : Uint8Array.of(0x61, 0x10, 0x00),
          ],
        ],
      }),
    );
    await rig.run(KWP, { unit: "engine", values: ["boost"], openLog: rig.csv.open });
    expect(rig.output).toContain("boost not read: boost: reply holds 1 data bytes, 3 are needed");
    expect(rig.output).toContain("boost pressure: not read");
    expect(rig.csv.rows[1]?.slice(2)).toEqual([""]);
  });

  it("are read by data identifier over UDS", async () => {
    const rig = new Rig(new FakeElmCore({ 0x7e0: valueUds(new UdsEcu(0x7e8, [])) }));
    expect(await rig.run(UDS, { unit: "engine", values: ["boost"] })).toBe(0);
    expect(rig.output).toContain("boost pressure: 260 kPa");
    expect(rig.core.requests).toContain("22F410");
  });

  it("are listed without reading any", async () => {
    const rig = kwpRig();
    expect(await rig.run(KWP, { unit: "engine", list: true })).toBe(0);
    expect(rig.output).toContain("available values: boost, rail-temperature, refused");
    expect(rig.core.requests).not.toContain("2110");
  });

  it("list the choices for an unknown name", async () => {
    const rig = kwpRig();
    await expect(rig.run(KWP, { unit: "engine", values: ["boots"] })).rejects.toThrow(
      "unknown value boots; available: boost, rail-temperature, refused",
    );
  });

  it("are an error for a unit that defines none", async () => {
    const rig = kwpRig();
    await expect(
      rig.run(parseProfile(edit(KWP_PROFILE, ["units", "engine", "values"], undefined), "test"), {
        unit: "engine",
      }),
    ).rejects.toThrow(/defines no named values/);
  });

  it("need a profile to name a unit", async () => {
    const rig = new Rig(new FakeElmCore({}));
    await expect(rig.run(undefined, { unit: "engine" })).rejects.toThrow(ProfileError);
    await expect(rig.run(undefined, { unit: "engine" })).rejects.toThrow(
      "naming a unit needs --profile",
    );
  });
});

describe("the legislated values", () => {
  it("are read by name and logged", async () => {
    const rig = recordedRig();
    expect(
      await rig.run(undefined, {
        values: ["short-fuel-trim-b1", "fuel-level", "o2-sensor-2"],
        count: 2,
        openLog: rig.csv.open,
      }),
    ).toBe(0);
    expect(rig.csv.rows[0]?.slice(2)).toEqual([
      "short-term fuel trim bank 1 (%)",
      "fuel tank level (%)",
      "oxygen sensor 2 voltage (V)",
      "oxygen sensor 2 short-term fuel trim (%)",
    ]);
    expect(rig.csv.rows[1]?.slice(2)).toEqual(["-2.34375", "34.90196078", "0.43", "not used"]);
    expect(rig.csv.rows).toHaveLength(3);
    expect(rig.core.requests.filter((request) => request === "0106")).toHaveLength(2);
  });

  it("list only the supported values", async () => {
    const rig = recordedRig();
    expect(await rig.run(undefined, { list: true })).toBe(0);
    const listed = rig.lines.at(-1) ?? "";
    expect(listed).toContain("engine-speed");
    expect(listed).not.toContain("air-flow"); // identifier 10 is not in the car's bitmap
  });

  it("refuse a value the car lacks", async () => {
    const rig = recordedRig();
    await expect(rig.run(undefined, { values: ["air-flow"] })).rejects.toThrow(
      /unknown value air-flow/,
    );
    expect(rig.core.requests).not.toContain("0110");
  });
});

it("refuses a count below one", async () => {
  const rig = new Rig(new FakeElmCore({}));
  await expect(rig.run(undefined, { count: 0 })).rejects.toThrow(OptionError);
  await expect(rig.run(undefined, { count: 0 })).rejects.toThrow("--count must be at least 1");
});

it("splits comma-separated names", () => {
  expect(splitNames("a, b,,c ")).toEqual(["a", "b", "c"]);
  expect(splitNames(undefined)).toEqual([]);
});
