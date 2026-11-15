import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adapterTransport,
  parseTable,
  simulatedCar,
  tableHeader,
  DECODED_VALUE_TABLE,
  EXCHANGE_TABLE,
  FAULT_CODE_TABLE,
  IDENTIFICATION_TABLE,
  type Dialect,
} from "../src/core/index.js";
import { decodeShare, fragmentOfLink } from "../src/core/share.js";
import { run, type CliIo } from "../src/node/cli.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { shipped } from "./helpers/captures.js";

const W211 = shipped("mercedes-w211");
const ADAPTER = ["--adapter", "tcp://fake:1"];
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "obd-tabular-"));
  directories.push(directory);
  return directory;
}

async function cli(argv: readonly string[], directory: string) {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    out: (line) => lines.push(line),
    err: (text) => errors.push(text),
    ask: () => Promise.resolve(""),
    open: () => adapterTransport(simulatedCar(W211)),
    env: {},
    directory,
    connect: () => Promise.reject(new Error("no broker in this test")),
    central: () => {
      throw new Error("no radio in this test");
    },
    listPorts: () => Promise.resolve([]),
  };
  return { status: await run(argv, io), lines, errors };
}

const records = (dialect: Dialect, lines: readonly string[]) =>
  parseTable(dialect, `${lines.join("\n")}\n`);

describe("decode --format", () => {
  async function captured(): Promise<string> {
    const directory = await workspace();
    const result = await cli(
      ["capture", ...ADAPTER, "--profile", "mercedes-w211", "--output", "car.obdcap.json"],
      directory,
    );
    expect(result.status).toBe(0);
    return directory;
  }

  it.each([
    ["values", tableHeader(DECODED_VALUE_TABLE)],
    ["faults", tableHeader(FAULT_CODE_TABLE)],
    ["identification", tableHeader(IDENTIFICATION_TABLE)],
    ["exchanges", tableHeader(EXCHANGE_TABLE)],
  ] as const)(
    "prints the %s table as CSV, TSV and JSON with the one column set",
    async (view, header) => {
      const directory = await captured();
      const base = ["decode", "car.obdcap.json", "--profile", "mercedes-w211", "--table", view];
      const csv = await cli([...base, "--format", "csv"], directory);
      const tsv = await cli([...base, "--format", "tsv"], directory);
      const json = await cli([...base, "--format", "json"], directory);
      expect([csv.status, tsv.status, json.status]).toEqual([0, 0, 0]);
      const asCsv = records("csv", csv.lines);
      const asTsv = records("tsv", tsv.lines);
      expect(asCsv[0]).toEqual(header);
      // A capture reads no profile values, so that table is the header alone.
      expect(asCsv.length).toBeGreaterThan(view === "values" ? 0 : 1);
      expect(asTsv).toEqual(asCsv);
      const objects: unknown = JSON.parse(json.lines.join("\n"));
      expect(Array.isArray(objects) ? objects.length : -1).toBe(asCsv.length - 1);
    },
  );

  it("prints the values by default and the usual text without --format", async () => {
    const directory = await captured();
    const table = await cli(
      ["decode", "car.obdcap.json", "--profile", "mercedes-w211", "--format", "tsv"],
      directory,
    );
    expect(table.lines[0]).toBe(tableHeader(DECODED_VALUE_TABLE).join("\t"));
    const text = await cli(["decode", "car.obdcap.json", "--profile", "mercedes-w211"], directory);
    expect(text.lines[0]).toBe("decoded with profile mercedes-w211");
  });

  it("decodes under no profile to the OBD-II fault codes and identification", async () => {
    const directory = await captured();
    const faults = await cli(
      ["decode", "car.obdcap.json", "--format", "csv", "--table", "faults"],
      directory,
    );
    expect(records("csv", faults.lines)[0]).toEqual(tableHeader(FAULT_CODE_TABLE));
    const identification = await cli(
      ["decode", "car.obdcap.json", "--format", "csv", "--table", "identification"],
      directory,
    );
    expect(records("csv", identification.lines).map((row) => row[1])).toContain("VIN");
  });

  it("refuses --table without --format", async () => {
    const directory = await captured();
    const result = await cli(["decode", "car.obdcap.json", "--table", "faults"], directory);
    expect(result.status).toBe(1);
    expect(result.lines.at(-1)).toBe("error: --table needs --format");
  });
});

describe("a command that reads the car, with --format", () => {
  const profile = ["--profile", "mercedes-w211"];

  it("prints a scan's fault codes as a table and its notes on standard error", async () => {
    const directory = await workspace();
    const result = await cli(["scan", ...ADAPTER, ...profile, "--format", "csv"], directory);
    expect(result.status).toBe(0);
    expect(result.lines[0]?.split("\r\n")[0]).toBe(tableHeader(FAULT_CODE_TABLE).join(","));
    expect(result.lines.join("\n")).not.toContain("units answered");
    expect(result.errors.join("")).toContain("adapter:");
  });

  it("prints one unit's identification as TSV", async () => {
    const directory = await workspace();
    const result = await cli(
      ["ident", "engine", ...ADAPTER, ...profile, "--format", "tsv", "--table", "identification"],
      directory,
    );
    expect(result.status).toBe(0);
    expect(records("tsv", result.lines)[0]).toEqual(tableHeader(IDENTIFICATION_TABLE));
  });

  it("prints a generic OBD-II read's codes as JSON", async () => {
    const directory = await workspace();
    const result = await cli(["obd", ...ADAPTER, "--format", "json"], directory);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("keeps today's text output without --format and refuses --output with it", async () => {
    const directory = await workspace();
    const text = await cli(["scan", ...ADAPTER, ...profile], directory);
    expect(text.lines.join("\n")).toContain("units answered");
    const refused = await cli(
      ["scan", ...ADAPTER, ...profile, "--format", "csv", "--output", "x"],
      directory,
    );
    expect(refused.status).toBe(1);
    expect(refused.lines.at(-1)).toMatch(/^error: --format prints the table/);
  });
});

describe("--tsv", () => {
  it("writes the log as TSV and refuses to give both logs", async () => {
    const directory = await workspace();
    const result = await cli(
      ["battery", ...ADAPTER, "--duration", "0.05", "--interval", "0.01", "--tsv", "log.tsv"],
      directory,
    );
    expect(result.status).toBe(0);
    const written = await readFile(join(directory, "log.tsv"), "utf8");
    const rows = parseTable("tsv", written);
    expect(rows[0]).toEqual(["time", "elapsed (s)", "voltage (V)"]);
    expect(rows.length).toBeGreaterThan(1);
    expect(written).not.toContain("\r");
    const both = await cli(["battery", ...ADAPTER, "--csv", "a.csv", "--tsv", "a.tsv"], directory);
    expect(both.status).toBe(1);
    expect(both.lines.at(-1)).toBe("error: --csv and --tsv each write a log; give one");
  });
});

describe("share of a run CSV or TSV", () => {
  const rows = ["2026-11-15T10:00:00.000Z,0.000,700", "2026-11-15T10:00:01.000Z,1.000,900"];

  async function sharedSignal(name: string, text: string) {
    const directory = await workspace();
    await writeFile(join(directory, name), text);
    const result = await cli(["share", name], directory);
    expect(result.lines.at(-1)).toMatch(/^https:/);
    const fragment = fragmentOfLink(result.lines[0] ?? "");
    const decoded = await decodeShare(fragment ?? "", zlibShareCodec);
    if (!decoded.ok || decoded.value.kind !== "run-summary") throw new Error("not a run summary");
    return decoded.value.data.signals[0];
  }

  it("shares a CSV export as a run summary", async () => {
    const signal = await sharedSignal(
      "run.csv",
      `time,elapsed (s),speed (rpm)\r\n${rows.join("\r\n")}\r\n`,
    );
    expect(signal).toMatchObject({ signal: "speed", unit: "rpm", min: 700, max: 900, mean: 800 });
  });

  it("shares a TSV export as a run summary", async () => {
    const text = `time\telapsed (s)\tspeed (rpm)\n${rows.map((row) => row.split(",").join("\t")).join("\n")}\n`;
    expect(await sharedSignal("run.tsv", text)).toMatchObject({ signal: "speed", max: 900 });
  });

  it("names the first column that is not a run export's", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "bad.csv"), "when,elapsed (s),x\r\n");
    const result = await cli(["share", "bad.csv"], directory);
    expect(result.status).toBe(1);
    expect(result.lines.at(-1)).toBe(
      'error: bad.csv: column 1 of the header is "when" and a run export has "time" there',
    );
  });
});
