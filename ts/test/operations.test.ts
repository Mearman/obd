import { describe, expect, it } from "vitest";
import {
  ClearRefused,
  Elm,
  GuardError,
  Transcript,
  asciiEncode,
  clearUnit,
  fromHex,
  jsonText,
  obdCommand,
  printUnit,
  profileUnit,
  readUnit,
  renderMarkdown,
  reportCommandError,
  scanDocument,
  toHex,
  withSuffix,
  type ProfileCommand,
  type UnitReport,
} from "../src/core/index.js";
import { loadBuiltinProfile } from "../src/profiles/index.js";
import { MemoryFiles, runProfileCommand, type CommandRun } from "./helpers/command-rig.js";
import { FakeElmCore, KwpEcu, fakeTransport, type Responder } from "./helpers/fake-elm.js";
import { WritableMemoryStore } from "./helpers/unit-rig.js";

const PROFILE = loadBuiltinProfile("mercedes-w211");

/** A fake W211 with an engine unit and an ESP unit, and a record of what was said. */
class Car {
  readonly esp = new KwpEcu(0x785, [
    [0x5123, 0x61],
    [0x9003, 0x20],
  ]);
  readonly core = new FakeElmCore({
    0x7e0: new KwpEcu(0x7e8, []).respond,
    0x784: this.esp.respond,
  });
  readonly transport = fakeTransport(this.core);
  readonly store = new WritableMemoryStore();
  readonly files = new MemoryFiles();
  lines: string[] = [];

  async run(command: ProfileCommand, answer = ""): Promise<number> {
    const result = await runProfileCommand({
      transport: this.transport,
      profile: PROFILE,
      command,
      answer,
      store: this.store,
      files: this.files,
    });
    this.lines = result.lines;
    return result.status;
  }

  get output(): string {
    return this.lines.join("\n");
  }

  /** The first unit of the snapshot saved under `name`. */
  async savedUnit(name: string): Promise<unknown> {
    const units = field(parse(await this.store.readText(name)), "units");
    return element(units, 0);
  }
}

function element(value: unknown, index: number): unknown {
  return Array.isArray(value) ? Reflect.get(value, index) : undefined;
}

function parse(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function clear(save: string, yes = false): ProfileCommand {
  return { command: "clear", unit: "esp", save, yes };
}

describe("probe", () => {
  it("reports which units answer", async () => {
    const car = new Car();
    expect(await car.run({ command: "probe" })).toBe(0);
    expect(car.output).toContain("engine (7E0 -> 7E8): answered");
    expect(car.output).toContain("esp (784 -> 785): answered");
    expect(car.output).toContain("kombi (796 -> 797): no answer");
    expect(car.output).toContain("2 of 13 units answered");
    expect(car.output).toContain("address table is unconfirmed");
    expect(car.output).toContain("STN extensions: none (plain ELM327 command set)");
    expect(car.transport.closed).toBe(true);
    expect(car.core.requests).not.toContain("1802FF00");
  });
});

describe("faults and freeze frames", () => {
  it("prints codes and status", async () => {
    const car = new Car();
    expect(await car.run({ command: "faults", unit: "esp" })).toBe(0);
    expect(car.output).toContain("fault codes: 2");
    expect(car.output).toContain("5123  status 61");
    expect(car.output).toContain("9003  status 20");
  });

  it("reads a frame per code", async () => {
    const car = new Car();
    expect(await car.run({ command: "freeze", unit: "esp" })).toBe(0);
    expect(car.output).toContain("freeze frame: 0151230C8A31");
    expect(car.output).toContain("freeze frame: 0190030C8A31");
  });

  it("exits non-zero for a silent unit", async () => {
    const car = new Car();
    expect(await car.run({ command: "ident", unit: "kombi" })).toBe(1);
    expect(car.output).toContain("kombi (796 -> 797): no answer");
  });

  it("reports an unknown unit as an error", async () => {
    const car = new Car();
    expect(await car.run({ command: "faults", unit: "radio" })).toBe(1);
    expect(car.lines.at(-1)).toContain("has no unit 'radio'");
  });
});

describe("scan", () => {
  it("writes JSON and Markdown", async () => {
    const car = new Car();
    expect(await car.run({ command: "scan", freeze: true, output: "out/scan" })).toBe(0);
    const saved = parse(car.files.text("out/scan.json"));
    const units = field(saved, "units");
    const esp: unknown = Array.isArray(units)
      ? units.find((unit) => field(unit, "unit") === "esp")
      : undefined;
    expect(field(esp, "faults")).toEqual([
      { code: "5123", status: "61" },
      { code: "9003", status: "20" },
    ]);
    expect(field(field(esp, "freeze_frames"), "5123")).toBe("0151230C8A31");
    expect(field(saved, "profile")).toEqual({ name: "mercedes-w211", status: "unconfirmed" });
    const transcript = field(saved, "transcript");
    expect(
      Array.isArray(transcript) && transcript.some((entry) => String(entry).includes("1802FF00")),
    ).toBe(true);
    expect(String(field(saved, "taken"))).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    const markdown = car.files.text("out/scan.md");
    expect(markdown).toContain("| esp | yes | 2 |");
    expect(markdown).toContain("| kombi | no | not read |");
    expect(markdown).toContain("fault `5123`, status `61`, freeze frame `0151230C8A31`");
    expect(car.lines.at(-1)).toBe("wrote out/scan.json and out/scan.md");
  });

  it("writes the saved JSON the way Python's json.dump does", () => {
    const report: UnitReport = {
      unit: "esp",
      description: "Stability",
      requestId: "784",
      responseId: "785",
      answered: true,
      notes: [],
      identification: new Map([["identification", { hex: "41", text: "A" }]]),
      faults: [
        { code: "9003", status: "20" },
        { code: "5123", status: "61" },
      ],
      freezeFrames: new Map([["9003", "no answer"]]),
    };
    const adapter = {
      identity: "ELM327 v2.3",
      description: null,
      stnIdentity: null,
      voltage: "12.4V",
      hasStnExtensions: false,
    };
    const { json } = scanDocument(
      { name: "p", status: "confirmed" },
      adapter,
      [report],
      ["> ATZ", "caf\u00e9"],
    );
    const text = jsonText(json).replace(/"taken": "[^"]*"/, '"taken": "T"');
    expect(text).toBe(
      [
        "{",
        '  "tool": "obd-read",',
        '  "taken": "T",',
        '  "profile": {',
        '    "name": "p",',
        '    "status": "confirmed"',
        "  },",
        '  "adapter": {',
        '    "identity": "ELM327 v2.3",',
        '    "description": null,',
        '    "stn_identity": null,',
        '    "voltage": "12.4V"',
        "  },",
        '  "units": [',
        "    {",
        '      "unit": "esp",',
        '      "description": "Stability",',
        '      "request_id": "784",',
        '      "response_id": "785",',
        '      "answered": true,',
        '      "notes": [],',
        '      "identification": {',
        '        "identification": {',
        '          "hex": "41",',
        '          "text": "A"',
        "        }",
        "      },",
        '      "faults": [',
        "        {",
        '          "code": "9003",',
        '          "status": "20"',
        "        },",
        "        {",
        '          "code": "5123",',
        '          "status": "61"',
        "        }",
        "      ],",
        '      "freeze_frames": {',
        '        "9003": "no answer"',
        "      }",
        "    }",
        "  ],",
        '  "transcript": [',
        '    "> ATZ",',
        '    "caf\\u00e9"',
        "  ]",
        "}",
      ].join("\n"),
    );
    expect(renderMarkdown({ name: "p", status: "confirmed" }, "T", [report])).toContain(
      "| esp | yes | 2 |",
    );
  });

  it("replaces the last suffix as Python's with_suffix does", () => {
    expect(withSuffix("scan", ".json")).toBe("scan.json");
    expect(withSuffix("out/scan.x", ".md")).toBe("out/scan.md");
    expect(withSuffix("a.b/scan", ".md")).toBe("a.b/scan.md");
    expect(withSuffix("x.tar.gz", ".json")).toBe("x.tar.json");
    expect(withSuffix(".hidden", ".json")).toBe(".hidden.json");
  });
});

describe("request", () => {
  it("sends read-only bytes", async () => {
    const car = new Car();
    expect(await car.run({ command: "request", unit: "esp", request: "1A86" })).toBe(0);
    expect(car.lines.at(-1)?.startsWith("5A86")).toBe(true);
  });

  it("takes whitespace between the bytes, as bytes.fromhex does", async () => {
    const car = new Car();
    expect(await car.run({ command: "request", unit: "esp", request: " 1A 86\n" })).toBe(0);
    expect(car.lines.at(-1)?.startsWith("5A86")).toBe(true);
  });

  it.each(["14FF00", "3101", "3B0100", "2701", "1085", "zz"])(
    "cannot change the car with %s",
    async (request) => {
      const car = new Car();
      expect(await car.run({ command: "request", unit: "esp", request })).toBe(1);
      expect(car.lines.at(-1)?.startsWith("error:")).toBe(true);
      expect(car.core.requests).toEqual([]);
      expect(car.esp.faults).toHaveLength(2);
    },
  );

  it("names the text it could not read as Python's repr does", async () => {
    const car = new Car();
    await car.run({ command: "request", unit: "esp", request: "zz" });
    expect(car.lines.at(-1)).toBe("error: request is not hexadecimal bytes: 'zz'");
  });
});

describe("clear", () => {
  it("saves, then clears, then reads again", async () => {
    const car = new Car();
    expect(await car.run(clear("before.json"), "yes")).toBe(0);
    const unit = await car.savedUnit("before.json");
    expect(field(unit, "faults")).toEqual([
      { code: "5123", status: "61" },
      { code: "9003", status: "20" },
    ]);
    expect(field(unit, "freeze_frames")).toEqual({
      "5123": "0151230C8A31",
      "9003": "0190030C8A31",
    });
    const requests = car.core.requests;
    expect(requests.indexOf("14FF00")).toBeGreaterThan(requests.indexOf("12FF049003"));
    expect(requests.slice(requests.indexOf("14FF00") + 1)).toEqual(["1092", "1A86", "1802FF00"]);
    expect(car.esp.faults).toEqual([]);
    expect(car.output).toContain("cleared; reading the unit again:");
    expect(car.lines.at(-1)).toBe("  fault codes: 0");
  });

  it("sends no clear when the prompt is declined", async () => {
    const car = new Car();
    expect(await car.run(clear("before.json"), "y")).toBe(1);
    expect(car.core.requests).not.toContain("14FF00");
    expect(car.esp.faults).toHaveLength(2);
    expect(await car.store.exists("before.json")).toBe(true);
    expect(car.lines.at(-1)).toBe("nothing cleared");
  });

  it("refuses an existing snapshot file", async () => {
    const car = new Car();
    car.store.write("before.json", "an earlier snapshot");
    expect(await car.run(clear("before.json", true))).toBe(1);
    expect(car.core.requests).toEqual([]);
    expect(await car.store.readText("before.json")).toBe("an earlier snapshot");
  });

  it("refuses when the codes cannot be read", async () => {
    const car = new Car();
    car.core.responders[0x784] = (request) => [[0x785, Uint8Array.of(0x7f, request[0] ?? 0, 0x11)]];
    expect(await car.run(clear("before.json", true))).toBe(1);
    expect(car.core.requests).not.toContain("14FF00");
    expect(await car.store.exists("before.json")).toBe(false);
    expect(car.lines.at(-1)).toContain("nothing cleared");
  });

  it("proceeds when only freeze frames are refused", async () => {
    const car = new Car();
    car.esp.freezeRefused = true;
    expect(await car.run(clear("before.json", true))).toBe(0);
    const unit = await car.savedUnit("before.json");
    expect(String(field(field(unit, "freeze_frames"), "5123")).startsWith("not read:")).toBe(true);
    expect(car.esp.faults).toEqual([]);
  });

  it("sends nothing to a silent unit", async () => {
    const car = new Car();
    expect(await car.run({ command: "clear", unit: "kombi", save: "before.json", yes: true })).toBe(
      1,
    );
    expect(car.core.requests).not.toContain("14FF00");
    expect(await car.store.exists("before.json")).toBe(false);
  });

  it("sends nothing when the snapshot has gone by the time of the clear", async () => {
    const car = new Car();
    const elm = new Elm(car.transport);
    const adapter = await elm.initialise();
    await elm.selectCan(11, 500_000);
    await expect(
      clearUnit({
        elm,
        profile: PROFILE,
        adapter,
        unit: profileUnit(PROFILE, "esp"),
        store: car.store,
        save: "before.json",
        confirm: () => {
          car.store.remove("before.json");
          return Promise.resolve(true);
        },
      }),
    ).rejects.toThrow(/has gone/);
    expect(car.core.requests).not.toContain("14FF00");
    expect(car.esp.faults).toHaveLength(2);
  });

  it("refuses with ClearRefused naming the file", async () => {
    const car = new Car();
    car.store.write("before.json", "x");
    const elm = new Elm(car.transport);
    await expect(
      clearUnit({
        elm,
        profile: PROFILE,
        adapter: await elm.initialise(),
        unit: profileUnit(PROFILE, "esp"),
        store: car.store,
        save: "before.json",
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(ClearRefused);
  });
});

describe("the obd command", () => {
  /** A car that answers legislated requests with the given replies, keyed by upper-case hex. */
  async function runObd(replies: Record<string, string>): Promise<CommandRun> {
    const respond: Responder = (request) => {
      const reply = replies[toHex(request).toUpperCase()];
      return reply === undefined ? [] : [[0x7e8, fromHex(reply)]];
    };
    const core = new FakeElmCore({ 0x7df: respond });
    const elm = new Elm(fakeTransport(core));
    await elm.initialise();
    const lines: string[] = [];
    const status = await obdCommand(elm, { idBits: 11, bitrate: 500_000 }, (line) =>
      lines.push(line),
    );
    expect(core.requests).not.toContain("04");
    return { status, lines };
  }

  it("needs no profile", async () => {
    const { status, lines } = await runObd({
      "0902": `490201${toHex(asciiEncode("WDB2110200A000000"))}`,
      "03": "43010420",
    });
    expect(status).toBe(0);
    expect(lines).toContain("VIN: WDB2110200A000000");
    expect(lines).toContain("stored codes from 7E8: P0420");
  });

  it("reads freeze frame and misfire counts", async () => {
    const { lines } = await runObd({
      "020200": "4202000302",
      "020500": "42050072",
      "020C00": "420c002c00",
      "06A1": "46a10c2400040000ffff",
      "06A2": "46a20b2400000000ffffa20c2400010000ffff",
      "06A3": "46a30b2400540000ffffa30c2400030000ffff",
    });
    const output = lines.join("\n");
    expect(output).toContain("freeze frame from 7E8: P0302");
    expect(output).toContain("coolant temperature: 74 \u00b0C");
    expect(output).toContain("engine speed: 2816 rpm");
    expect(output).toContain("engine: last cycle 4, average of last ten cycles not reported");
    expect(output).toContain("cylinder 1: last cycle 1, average of last ten cycles 0");
    expect(output).toContain("cylinder 2: last cycle 3, average of last ten cycles 84");
    expect(output).not.toContain("cylinder 3");
  });

  it("prints neither freeze frame nor misfire counts when there are none", async () => {
    const { lines } = await runObd({});
    const output = lines.join("\n");
    expect(output).not.toContain("freeze frame");
    expect(output).not.toContain("misfire counts");
  });
});

describe("the transcript", () => {
  it("records the whole exchange for a log", async () => {
    const car = new Car();
    const log: string[] = [];
    const result = await runProfileCommand({
      transport: car.transport,
      makeElm: (transport) =>
        new Elm(transport, { transcript: new Transcript((entry) => log.push(entry)) }),
      profile: PROFILE,
      command: { command: "ident", unit: "esp" },
    });
    expect(result.status).toBe(0);
    const text = log.join("\n");
    expect(text).toContain("> ATSH784");
    expect(text).toContain("> 1A86");
    expect(text).toContain("< 785");
  });
});

describe("readUnit", () => {
  it("reports a unit that refuses the session as answered with a note", async () => {
    const core = new FakeElmCore({
      0x784: (request) => [[0x785, Uint8Array.of(0x7f, request[0] ?? 0, 0x22)]],
    });
    const elm = new Elm(fakeTransport(core));
    await elm.initialise();
    await elm.selectCan(11, 500_000);
    const report = await readUnit(elm, PROFILE, profileUnit(PROFILE, "esp"), {
      faults: true,
      freeze: false,
    });
    expect(report.answered).toBe(true);
    expect(report.notes[0]).toBe(
      "session request refused: service 10 refused with code 22 (conditions not correct)",
    );
    expect(report.notes).toContain(
      "identification not read: service 1A refused with code 22 (conditions not correct)",
    );
    expect(report.faults).toBeNull();
    const lines: string[] = [];
    printUnit(report, (line) => lines.push(line));
    expect(lines[0]).toBe("esp (784 -> 785): answered");
  });
});

describe("reportCommandError", () => {
  it("prints a command error and rethrows anything else", () => {
    const lines: string[] = [];
    expect(reportCommandError(new GuardError("refused"), (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual(["error: refused"]);
    expect(() => reportCommandError(new TypeError("bug"), () => undefined)).toThrow(TypeError);
  });
});
