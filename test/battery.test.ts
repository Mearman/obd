import { describe, expect, it } from "vitest";
import {
  Elm,
  ElmError,
  OptionError,
  VOLTAGE,
  batteryCommand,
  readVoltage,
  type AdapterInfo,
} from "../src/core/index.js";
import { FakeElmCore, fakeTransport, type FakeElmOptions } from "./helpers/fake-elm.js";
import { MemoryCsv } from "./helpers/memory-csv.js";

// Voltages as an adapter reports them through an engine start: resting, cranking dip, charging.
const START = [
  "12.6V",
  "12.5V",
  "9.8V",
  "10.4V",
  "13.9V",
  "14.2V",
  "14.3V",
  "14.3V",
  "14.3V",
  "14.3V",
];

/** A fake adapter whose voltage command replays a script, then repeats its last value. */
class VoltageCore extends FakeElmCore {
  readonly reads: string[] = [];

  constructor(
    private readonly script: readonly string[],
    stn = false,
  ) {
    const options: FakeElmOptions = stn ? { stnIdentity: "STN1110 v4.0" } : {};
    super({}, options);
  }

  protected override handle(line: string): string {
    if (line === "ATRV" || line.startsWith("STVR")) {
      this.sent.push(line);
      this.reads.push(line);
      return this.script[Math.min(this.reads.length - 1, this.script.length - 1)] ?? "";
    }
    return super.handle(line);
  }
}

/** Initialises the session as the command line does, then runs the battery command. */
async function run(
  core: VoltageCore,
  options: Partial<Parameters<typeof batteryCommand>[2]>,
): Promise<{ status: number; lines: string[] }> {
  const elm = new Elm(fakeTransport(core));
  const adapter: AdapterInfo = await elm.initialise();
  const lines: string[] = [];
  const status = await batteryCommand(
    elm,
    adapter,
    { durationMs: 0, intervalMs: 1000, ...options },
    (line) => lines.push(line),
  );
  return { status, lines };
}

describe("the battery command", () => {
  it("logs the voltage through a start", async () => {
    const core = new VoltageCore(START);
    const log = new MemoryCsv();
    const { status, lines } = await run(core, {
      durationMs: 450,
      intervalMs: 50,
      openLog: log.open,
    });
    expect(status).toBe(0);
    const table = log.rows;
    expect(table[0]).toEqual(["time", "elapsed (s)", "voltage (V)"]);
    // The first read is the adapter's own start-up reading, so the log starts at the second value.
    expect(table.slice(1, 4).map((row) => row[2])).toEqual(["12.5", "9.8", "10.4"]);
    expect(table.length).toBeGreaterThanOrEqual(4);
    const elapsed = table.slice(1).map((row) => Number(row[1]));
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    expect(lines.at(-1)).toContain("lowest 9.8 V");
    expect(core.reads[0]).toBe("ATRV");
    expect(log.closed).toBe(true);
  });

  it("takes one sample when the duration is zero", async () => {
    const core = new VoltageCore(START);
    const { status, lines } = await run(core, { durationMs: 0 });
    expect(status).toBe(0);
    expect(lines.at(-1)).toContain("1 sample: lowest 12.5 V");
    expect(core.reads).toHaveLength(2); // start-up reading and one sample
  });

  it("reads an adapter with STN extensions with STVR", async () => {
    const core = new VoltageCore(["12.60V", "12.345V"], true);
    const { lines } = await run(core, { durationMs: 0, precision: 3 });
    expect(core.reads).toEqual(["ATRV", "STVR 3"]);
    expect(lines.at(-1)).toContain("12.345 V");
    expect(lines.join("\n")).toContain("with STVR");
  });

  it("sends STVR bare without a precision", async () => {
    const core = new VoltageCore(["12.6V"], true);
    await run(core, { durationMs: 0 });
    expect(core.reads).toEqual(["ATRV", "STVR"]);
  });

  it("fails on a reply with no voltage", async () => {
    const core = new VoltageCore(["12.6V", "OK"]);
    await expect(run(core, { durationMs: 0 })).rejects.toThrow(/no voltage in the reply to ATRV/);
  });

  it.each([[{ intervalMs: 0 }], [{ durationMs: -1000 }], [{ precision: -1 }]])(
    "refuses the bad numbers %j",
    async (options) => {
      await expect(run(new VoltageCore(START), options)).rejects.toThrow(OptionError);
      await expect(run(new VoltageCore(START), options)).rejects.toThrow(/^--/);
    },
  );
});

describe("readVoltage", () => {
  it("takes the first voltage in any line", async () => {
    const elm = new Elm(fakeTransport(new VoltageCore(["SEARCHING...\r13.1 V"])));
    expect(await readVoltage(elm, { stn: false })).toBe(13.1);
  });

  it("names the command when nothing parses", async () => {
    const elm = new Elm(fakeTransport(new VoltageCore(["?"])));
    await expect(readVoltage(elm, { stn: true, precision: 2 })).rejects.toThrow(/STVR 2/);
    await expect(readVoltage(elm, { stn: true, precision: 2 })).rejects.toThrow(ElmError);
  });
});

it("matches a voltage pattern", () => {
  expect(VOLTAGE.exec("14.35V")?.[1]).toBe("14.35");
  expect(VOLTAGE.exec("OK")).toBeNull();
});
