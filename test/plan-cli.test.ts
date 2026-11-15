import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiagProtocol,
  PLAN_PHASE_SIGNAL,
  adapterTransport,
  planPhases,
  runExportSchema,
  simulatedLiveCar,
} from "../src/core/index.js";
import { run, type CliIo } from "../src/node/cli.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { uncheckedFragment } from "./support/hostile-share.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "obd-plan-"));
  directories.push(directory);
  return directory;
}

interface Options {
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
  readonly onLine?: (line: string) => void;
}

/** Runs the command line in `directory` against a simulated generic car, counting the adapters it opens. */
async function cli(argv: readonly string[], directory: string, options: Options = {}) {
  const lines: string[] = [];
  let opened = 0;
  const io: CliIo = {
    out: (line) => {
      lines.push(line);
      options.onLine?.(line);
    },
    err: () => undefined,
    ask: () => Promise.resolve(""),
    open: () => {
      opened += 1;
      return adapterTransport(
        simulatedLiveCar({ protocol: DiagProtocol.KWP2000, units: new Map() }),
      );
    },
    env: {},
    directory,
    connect: () => Promise.reject(new Error("no broker in this test")),
    central: () => {
      throw new Error("no radio in this test");
    },
    listPorts: () => Promise.resolve([]),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return { status: await run(argv, io), lines, opened };
}

/** A short plan: a confirmation when asked for, then a handful of quick samples with code reads. */
function shortPlan(options: { confirm?: boolean; long?: boolean } = {}): string {
  const phases: unknown[] = [];
  if (options.confirm === true) {
    phases.push({
      id: "ready",
      title: "Ready",
      instruction: "Parked: confirm when ready.",
      end: { when: { kind: "confirm", prompt: "Ready?" }, timeout: 30 },
    });
  }
  phases.push({
    id: "idle",
    title: "Idle",
    instruction: "Parked, handbrake on, in neutral: let it idle.",
    sample: { every: 0.02 },
    reads: { start: ["stored-codes"], end: ["stored-codes", "freeze-frame"] },
    end:
      options.long === true
        ? { when: { kind: "elapsed", seconds: 600 }, timeout: 900 }
        : { when: { kind: "samples", count: 3 }, timeout: 30 },
  });
  return JSON.stringify({
    format: "obd-read-plan",
    version: 1,
    name: "short",
    title: "Short test plan",
    description: "A test.",
    source: "A test.",
    needs: { values: ["engine-speed", "coolant-temperature"] },
    phases,
  });
}

const ADAPTER = ["--adapter", "simulator://generic-obd2"];

/** The short plan as an object, for a test that changes a field of it. */
function planObject(): object {
  const parsed: unknown = JSON.parse(shortPlan());
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return parsed;
}

describe("obd-read plan", () => {
  it("lists the shipped plans with their titles", async () => {
    const { status, lines, opened } = await cli(["plan", "list"], await workspace());
    expect(status).toBe(0);
    expect(lines).toEqual([
      "cold-start-warm-up: Cold start and warm-up",
      "drive-cycle-watch: Watch codes through a drive",
      "idle-then-rev: Idle, hold revs, idle, blips",
      "misfire-under-load: Misfire counters under revs",
    ]);
    expect(opened).toBe(0);
  });

  it("shows a plan's phases with their instructions, conditions and timeouts", async () => {
    const { status, lines } = await cli(["plan", "show", "idle-then-rev"], await workspace());
    expect(status).toBe(0);
    expect(lines[0]).toBe("idle-then-rev: Idle, hold revs, idle, blips");
    expect(lines).toContain("phase 4: blip, Quick blip, 3 times");
    expect(lines).toContain(
      "  ends when engine-speed between 2000 and 2500 for 60 s (at most 240 s, then skip)",
    );
  });

  it("validates plan files, listing every problem of an invalid one with the valid value names", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "good.obdplan.json"), shortPlan());
    await writeFile(
      join(directory, "bad.obdplan.json"),
      shortPlan().replace('"engine-speed"', '"engine-sped"'),
    );
    const { status, lines } = await cli(
      ["plan", "validate", "good.obdplan.json", "bad.obdplan.json"],
      directory,
    );
    expect(status).toBe(1);
    expect(lines[0]).toBe("good.obdplan.json: valid plan short, 1 phases");
    expect(lines[1]).toMatch(
      /^bad\.obdplan\.json: invalid plan: needs\.values: unknown value engine-sped; valid values: .*engine-speed/,
    );
  });

  it("names the shipped plans when asked for one that does not exist", async () => {
    const { status, lines } = await cli(["plan", "show", "nope"], await workspace());
    expect(status).toBe(1);
    expect(lines).toEqual([
      "error: 'nope': no such plan: shipped plans: cold-start-warm-up, drive-cycle-watch, idle-then-rev, misfire-under-load",
    ]);
  });
});

describe("obd-read record", () => {
  it("runs a plan, printing each phase and its reads, and writes a run that share takes", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "short.obdplan.json"), shortPlan());
    const { status, lines } = await cli(
      [
        "record",
        ...ADAPTER,
        "--plan",
        "short.obdplan.json",
        "--output",
        "run.json",
        "--csv",
        "run.csv",
      ],
      directory,
    );
    expect(status).toBe(0);
    expect(lines).toContain("=== phase 1 of 1: Idle ===");
    expect(lines).toContain(">>> Parked, handbrake on, in neutral: let it idle.");
    expect(lines).toContain("ends when 3 samples (at most 30 s)");
    expect(lines).toContain("stored-codes: P0420 (7E8)");
    expect(lines).toContain("plan completed");
    expect(lines).toContain("wrote run.json; share it with: obd-read share run.json");
    const exported = runExportSchema.parse(
      JSON.parse(await readFile(join(directory, "run.json"), "utf8")),
    );
    expect(exported.run.notes).toBe("plan short: Short test plan");
    expect(planPhases(exported.samples).map((phase) => phase.outcome)).toEqual(["completed"]);
    const csv = await readFile(join(directory, "run.csv"), "utf8");
    expect(csv.split("\r\n")[0]).toContain(PLAN_PHASE_SIGNAL);
    const tabbed = await cli(
      [
        "record",
        ...ADAPTER,
        "--plan",
        "short.obdplan.json",
        "--output",
        "two.json",
        "--tsv",
        "run.tsv",
      ],
      directory,
    );
    expect(tabbed.status).toBe(0);
    const tsv = await readFile(join(directory, "run.tsv"), "utf8");
    expect(tsv.split(/\r?\n/)[0]?.split("\t")).toContain(PLAN_PHASE_SIGNAL);
    const shared = await cli(["share", "run.json"], directory);
    expect(shared.status).toBe(0);
    expect(shared.lines[0]).toMatch(/#share=/);
  });

  it("refuses a plan with a manual step when nobody is at a terminal, before connecting", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "confirm.obdplan.json"), shortPlan({ confirm: true }));
    const { status, lines, opened } = await cli(
      ["record", ...ADAPTER, "--plan", "confirm.obdplan.json", "--output", "run.json"],
      directory,
    );
    expect(status).toBe(1);
    expect(lines).toEqual([
      "error: plan short has steps the person confirms, and the input is not a terminal; run it at a terminal, or pass --yes-confirm to confirm each step at once",
    ]);
    expect(opened).toBe(0);
  });

  it("confirms each manual step with --yes-confirm, and asks at a terminal otherwise", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "confirm.obdplan.json"), shortPlan({ confirm: true }));
    const confirmed = await cli(
      [
        "record",
        ...ADAPTER,
        "--plan",
        "confirm.obdplan.json",
        "--output",
        "one.json",
        "--yes-confirm",
      ],
      directory,
    );
    expect(confirmed.status).toBe(0);
    expect(confirmed.lines).toContain("Ready? confirmed by --yes-confirm");
    const asked = await cli(
      ["record", ...ADAPTER, "--plan", "confirm.obdplan.json", "--output", "two.json"],
      directory,
      { interactive: true },
    );
    expect(asked.status).toBe(0);
  });

  it("refuses an output file that exists, and an unknown plan, before connecting", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "run.json"), "{}");
    const existing = await cli(
      ["record", ...ADAPTER, "--plan", "idle-then-rev", "--output", "run.json"],
      directory,
    );
    expect(existing).toMatchObject({
      status: 1,
      opened: 0,
      lines: ["error: run.json already exists; choose a new file"],
    });
    const unknown = await cli(
      ["record", ...ADAPTER, "--plan", "idle-then-reev", "--output", "new.json"],
      directory,
    );
    expect(unknown.status).toBe(1);
    expect(unknown.opened).toBe(0);
    expect(unknown.lines[0]).toMatch(/^error: 'idle-then-reev': no such plan: shipped plans: /);
  });

  it("aborts on an interrupt and still writes the run", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "long.obdplan.json"), shortPlan({ long: true }));
    const controller = new AbortController();
    const { status, lines } = await cli(
      ["record", ...ADAPTER, "--plan", "long.obdplan.json", "--output", "run.json"],
      directory,
      {
        onLine: (line) => {
          if (line.startsWith("stored-codes:")) controller.abort();
        },
        signal: controller.signal,
      },
    );
    expect(status).toBe(130);
    expect(lines).toContain("plan aborted: aborted");
    const exported = runExportSchema.parse(
      JSON.parse(await readFile(join(directory, "run.json"), "utf8")),
    );
    expect(exported.run.stoppedAt).not.toBeNull();
    expect(planPhases(exported.samples).map((phase) => phase.outcome)).toEqual(["aborted"]);
  });
});

describe("sharing plans and their results", () => {
  it("shares a plan as a link that opens read-only and imports as a plan file", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "short.obdplan.json"), shortPlan());
    const shared = await cli(["plan", "share", "short.obdplan.json"], directory);
    expect(shared.status).toBe(0);
    expect(shared.opened).toBe(0);
    const [link] = shared.lines;
    expect(link).toMatch(/^https:\/\/mearman\.github\.io\/obd\/#share=2\./);
    if (link === undefined) throw new Error("no link");

    const opened = await cli(["share", "--open", link], directory);
    expect(opened.status).toBe(0);
    expect(opened.opened).toBe(0);
    expect(opened.lines[0]).toMatch(/^shared plan, from a link/);
    expect(opened.lines).toContain("it only reads: no step clears, writes or actuates");
    expect(opened.lines).toContain("short: Short test plan");
    expect(opened.lines.some((line) => /^version: revision 1, [0-9a-f]{12}$/.test(line))).toBe(
      true,
    );

    // The original file is in the way, so an import without --output refuses to overwrite it.
    const refused = await cli(["plan", "import", link], directory);
    expect(refused.status).toBe(1);
    const imported = await cli(
      ["plan", "import", link, "--output", "copy.obdplan.json"],
      directory,
    );
    expect(imported.status).toBe(0);
    expect(imported.lines[0]).toMatch(/^wrote copy\.obdplan\.json: short, revision 1, /);
    const validated = await cli(["plan", "validate", "copy.obdplan.json"], directory);
    expect(validated.lines).toEqual(["copy.obdplan.json: valid plan short, 1 phases"]);
  });

  it("shares a recorded plan run as a plan result carrying the whole plan", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "short.obdplan.json"), shortPlan());
    const recorded = await cli(
      ["record", ...ADAPTER, "--plan", "short.obdplan.json", "--output", "run.json"],
      directory,
    );
    expect(recorded.status).toBe(0);
    const shared = await cli(["share", "run.json"], directory);
    expect(shared.status).toBe(0);
    const [link] = shared.lines;
    if (link === undefined) throw new Error("no link");
    const opened = await cli(["share", "--open", link], directory);
    expect(opened.status).toBe(0);
    expect(opened.lines[1]).toMatch(
      /^shared plan result for short \(Short test plan\), revision 1, [0-9a-f]{12}$/,
    );
    expect(opened.lines.some((line) => line.startsWith("phase idle, Idle: completed, from "))).toBe(
      true,
    );
    expect(opened.lines.some((line) => line.startsWith("  stored-codes at the start"))).toBe(true);
    expect(opened.lines).toContain(
      "code P0420 appeared in the stored list at 0.0 s (there from the start)",
    );
    expect(opened.lines).toContain("the plan:");
    expect(opened.lines).toContain("  short: Short test plan");
    // The plan inside the result imports like a plan link.
    const imported = await cli(
      ["plan", "import", link, "--output", "back.obdplan.json"],
      directory,
    );
    expect(imported.status).toBe(0);
  });

  it("refuses a plan link whose plan is invalid, listing every problem", async () => {
    const directory = await workspace();
    const fragment = await uncheckedFragment(
      "plan",
      {
        v: 1,
        kind: "plan",
        createdAt: 0,
        data: { plan: { ...planObject(), needs: { values: ["engine-sped"] } } },
      },
      zlibShareCodec,
    );
    const link = `https://example.com/#${fragment}`;
    const opened = await cli(["share", "--open", link], directory);
    expect(opened.status).toBe(1);
    expect(opened.lines.join("\n")).toMatch(/unknown value engine-sped; valid values: /);
    const imported = await cli(["plan", "import", link], directory);
    expect(imported.status).toBe(1);
    expect(imported.lines.join("\n")).toMatch(/unknown value engine-sped/);
  });
});
