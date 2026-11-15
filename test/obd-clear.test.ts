import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  GuardError,
  clearCodesCommand,
  concatBytes,
  fromHex,
  obdCommand,
  permit,
  printAdapter,
  profileCommand,
  reportCommandError,
  toUpperHex,
} from "../src/core/index.js";
import { loadBuiltinProfile } from "../src/profiles/index.js";
import { MemoryFiles } from "./helpers/command-rig.js";
import { FakeElmCore, fakeTransport } from "./helpers/fake-elm.js";
import { WritableMemoryStore } from "./helpers/unit-rig.js";

/** A fake legislated-OBD car with one engine unit that holds a stored code until mode 04. */
class ObdCar {
  codes: Uint8Array[] = [fromHex("0420")];
  readonly core = new FakeElmCore({ 0x7df: (request) => this.respond(request) });
  readonly transport = fakeTransport(this.core);
  readonly store = new WritableMemoryStore();
  lines: string[] = [];
  refuseClear = false;

  respond(request: Uint8Array): [number, Uint8Array][] {
    const key = toUpperHex(request);
    if (key === "04") {
      if (this.refuseClear) return [[0x7e8, fromHex("7F0422")]];
      this.codes = [];
      return [[0x7e8, Uint8Array.of(0x44)]];
    }
    if (key === "03")
      return [[0x7e8, concatBytes(Uint8Array.of(0x43, this.codes.length), ...this.codes)]];
    if (key === "07") return [[0x7e8, Uint8Array.of(0x47, 0)]];
    if (key === "0101") {
      return [
        [
          0x7e8,
          Uint8Array.of(
            0x41,
            0x01,
            (this.codes.length > 0 ? 0x80 : 0) | this.codes.length,
            0,
            0,
            0,
          ),
        ],
      ];
    }
    if (key === "0902")
      return [
        [
          0x7e8,
          fromHex(
            `490201${"WDB2110200A000000"
              .split("")
              .map((c) => c.charCodeAt(0).toString(16))
              .join("")}`,
          ),
        ],
      ];
    if (key === "020200") return this.codes.length > 0 ? [[0x7e8, fromHex("4202000420")]] : [];
    return [];
  }

  /** Runs `clear-codes` on a fresh session, as the command line does. */
  async clearCodes(options: {
    save?: string;
    yes?: boolean;
    answer?: string;
    beforeAnswer?: () => void;
  }): Promise<number> {
    this.lines = [];
    const out = (line: string): void => {
      this.lines.push(line);
    };
    await this.transport.open();
    try {
      const elm = new Elm(this.transport);
      const adapter = await elm.initialise();
      printAdapter(adapter, out);
      return await clearCodesCommand({
        elm,
        adapter,
        store: this.store,
        idBits: 11,
        bitrate: 500_000,
        save: options.save ?? "before.json",
        yes: options.yes ?? false,
        out,
        ask: () => {
          options.beforeAnswer?.();
          return Promise.resolve(options.answer ?? "");
        },
      });
    } catch (error) {
      return reportCommandError(error, out);
    } finally {
      await this.transport.close();
    }
  }

  get output(): string {
    return this.lines.join("\n");
  }

  get clearsSent(): number {
    return this.core.requests.filter((request) => request === "04").length;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function keys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function parse(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

describe("clear-codes", () => {
  it("saves, then clears, then reads again", async () => {
    const car = new ObdCar();
    expect(await car.clearCodes({ answer: "yes" })).toBe(0);
    const saved = parse(await car.store.readText("before.json"));
    const snapshot = field(saved, "snapshot");
    expect(field(snapshot, "stored")).toEqual({ "7E8": ["P0420"] });
    expect(field(snapshot, "vin")).toBe("WDB2110200A000000");
    expect(field(field(field(snapshot, "freeze_frames"), "7E8"), "code")).toBe("P0420");
    const transcript = field(saved, "transcript");
    expect(Array.isArray(transcript) && transcript.some((e) => String(e).endsWith("0902"))).toBe(
      true,
    );
    const requests = car.core.requests;
    expect(requests.indexOf("04")).toBeGreaterThan(requests.indexOf("020200"));
    expect(requests.indexOf("04")).toBeGreaterThan(requests.indexOf("03"));
    expect(requests.slice(requests.indexOf("04") + 1)).toEqual(["03", "07", "0101"]);
    expect(car.codes).toEqual([]);
    expect(car.output).toContain("every emissions-related unit");
    expect(car.output).toContain("resets the readiness monitors");
    expect(car.output).toContain("readiness monitors are reset");
    expect(car.lines.slice(car.lines.indexOf("reading the codes again:") + 1)).toEqual([
      "stored codes from 7E8: none",
      "pending codes from 7E8: none",
      "unit 7E8: warning lamp off, 0 stored codes",
    ]);
  });

  it("saves the snapshot with the keys in the order Python wrote them", async () => {
    const car = new ObdCar();
    await car.clearCodes({ yes: true });
    const text = await car.store.readText("before.json");
    expect(text.endsWith("}\n")).toBe(true);
    expect(keys(parse(text))).toEqual(["tool", "taken", "adapter", "snapshot", "transcript"]);
    expect(keys(field(parse(text), "snapshot"))).toEqual([
      "vin",
      "readiness",
      "stored",
      "pending",
      "permanent",
      "freeze_frames",
      "misfire_counts",
      "notes",
    ]);
    expect(text).toContain(
      '"readiness": {\n      "7E8": {\n        "lamp_on": true,\n        "code_count": 1\n      }\n    }',
    );
  });

  it.each(["", "y", "no", "YES"])("leaves mode 04 unsent when the answer is %j", async (answer) => {
    const car = new ObdCar();
    expect(await car.clearCodes({ answer })).toBe(1);
    expect(car.clearsSent).toBe(0);
    expect(car.codes).not.toEqual([]);
    expect(await car.store.exists("before.json")).toBe(true);
    expect(car.lines.at(-1)).toBe("nothing cleared");
  });

  it("skips the prompt with the yes option", async () => {
    const car = new ObdCar();
    expect(await car.clearCodes({ yes: true })).toBe(0);
    expect(car.clearsSent).toBe(1);
  });

  it("leaves mode 04 unsent when the save file exists", async () => {
    const car = new ObdCar();
    car.store.write("before.json", "an earlier snapshot");
    expect(await car.clearCodes({ yes: true })).toBe(1);
    expect(car.core.requests).toEqual([]);
    expect(await car.store.readText("before.json")).toBe("an earlier snapshot");
  });

  it("leaves mode 04 unsent when the snapshot cannot be read", async () => {
    const car = new ObdCar();
    // A stored-codes reply that declares more codes than it carries cannot be saved.
    car.core.responders[0x7df] = (request) =>
      toUpperHex(request) === "03" ? [[0x7e8, fromHex("4305")]] : car.respond(request);
    expect(await car.clearCodes({ yes: true })).toBe(1);
    expect(car.clearsSent).toBe(0);
    expect(await car.store.exists("before.json")).toBe(false);
    expect(car.lines.at(-1)).toContain("nothing cleared");
  });

  it("leaves mode 04 unsent when the car is silent", async () => {
    const car = new ObdCar();
    car.core.responders[0x7df] = () => [];
    expect(await car.clearCodes({ yes: true })).toBe(1);
    expect(car.clearsSent).toBe(0);
    expect(await car.store.exists("before.json")).toBe(false);
  });

  it("sends nothing when the save file is removed before the clear", async () => {
    const car = new ObdCar();
    expect(
      await car.clearCodes({
        answer: "yes",
        beforeAnswer: () => {
          car.store.remove("before.json");
        },
      }),
    ).toBe(1);
    expect(car.clearsSent).toBe(0);
    expect(car.codes).not.toEqual([]);
    expect(car.lines.at(-1)).toContain("has gone");
  });

  it("reports a unit that refuses the clear as an error", async () => {
    const car = new ObdCar();
    car.refuseClear = true;
    expect(await car.clearCodes({ yes: true })).toBe(1);
    expect(car.lines.at(-1)).toContain("refused the clear with code 22");
    expect(car.codes).not.toEqual([]);
  });
});

describe("the other commands cannot send mode 04", () => {
  it("not the obd command", async () => {
    const car = new ObdCar();
    const elm = new Elm(car.transport);
    await elm.initialise();
    expect(await obdCommand(elm, { idBits: 11, bitrate: 500_000 }, () => undefined)).toBe(0);
    expect(car.clearsSent).toBe(0);
    await expect(permit(DiagProtocol.OBD, Uint8Array.of(0x04))).rejects.toThrow(GuardError);
  });

  it("not the request command", async () => {
    const car = new ObdCar();
    const elm = new Elm(car.transport);
    const adapter = await elm.initialise();
    const profile = loadBuiltinProfile("mercedes-w211");
    const lines: string[] = [];
    const run = async (): Promise<number> =>
      profileCommand(
        { command: "request", unit: "engine", request: "04" },
        {
          elm,
          adapter,
          profile,
          store: car.store,
          files: new MemoryFiles(),
          out: (line) => lines.push(line),
          ask: () => Promise.resolve(""),
        },
      );
    const status = await run().catch((error: unknown) =>
      reportCommandError(error, (line) => lines.push(line)),
    );
    expect(status).toBe(1);
    expect(car.core.requests).toEqual([]);
  });
});
