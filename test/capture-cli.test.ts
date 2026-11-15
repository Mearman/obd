import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adapterTransport,
  isGzip,
  readCaptureFile,
  simulatedCar,
  type Transport,
} from "../src/core/index.js";
import { run, type CliIo } from "../src/node/cli.js";
import { toolVersion } from "../src/node/version.js";
import { shipped } from "./helpers/captures.js";

const W211 = shipped("mercedes-w211");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "obd-capture-"));
  directories.push(directory);
  return directory;
}

/** Runs the command line in `directory` against a fresh simulated W211, or `open` when given. */
async function cli(
  argv: readonly string[],
  directory: string,
  options: { readonly open?: () => Transport; readonly signal?: AbortSignal } = {},
): Promise<{ readonly status: number; readonly lines: string[] }> {
  const lines: string[] = [];
  const io: CliIo = {
    out: (line) => lines.push(line),
    err: (text) => lines.push(text),
    ask: () => Promise.resolve(""),
    open: options.open ?? (() => adapterTransport(simulatedCar(W211))),
    env: {},
    directory,
    connect: () => Promise.reject(new Error("no broker in this test")),
    central: () => {
      throw new Error("no radio in this test");
    },
    listPorts: () => Promise.resolve([]),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return { status: await run(argv, io), lines };
}

const ADAPTER = ["--adapter", "tcp://fake:1"];

describe("obd-read capture and decode", () => {
  it("captures with a profile and decodes the file to the scan's unit lines", async () => {
    const directory = await workspace();
    const captured = await cli(
      ["capture", ...ADAPTER, "--profile", "mercedes-w211", "--output", "car.obdcap.json"],
      directory,
    );
    expect(captured.status).toBe(0);
    expect(captured.lines.at(-1)).toBe(
      "wrote car.obdcap.json; decode it with: obd-read decode car.obdcap.json --profile mercedes-w211",
    );
    const capture = readCaptureFile(await readFile(join(directory, "car.obdcap.json")), "car");
    expect(capture.sessions[0]?.tool).toEqual({ name: "obd-read", version: toolVersion() });

    const decoded = await cli(
      ["decode", "car.obdcap.json", "--profile", "mercedes-w211"],
      directory,
    );
    const scanned = await cli(
      ["scan", ...ADAPTER, "--profile", "mercedes-w211", "--freeze"],
      directory,
    );
    expect(decoded.status).toBe(0);
    // The decode prints the scan's unit lines after its own heading, then the legislated reads.
    const unitLines = scanned.lines.filter((line) => !/^(adapter|ELM|voltage)/i.test(line));
    for (const line of unitLines.filter((line) => line.startsWith("  "))) {
      expect(decoded.lines).toContain(line);
    }
    expect(decoded.lines[0]).toBe("decoded with profile mercedes-w211");
    expect(decoded.lines).toContain("VIN: SIMULATEDCAR00001");
    expect(decoded.lines.at(-1)).toMatch(/^undecoded: 0 of \d+ exchanges$/);
  });

  it("decodes the same file under another profile and under none", async () => {
    const directory = await workspace();
    await cli(
      [
        "capture",
        ...ADAPTER,
        "--profile",
        "mercedes-w211",
        "--output",
        "car.obdcap.json.gz",
        "--compress",
      ],
      directory,
    );
    expect(isGzip(await readFile(join(directory, "car.obdcap.json.gz")))).toBe(true);
    const mqb = await cli(["decode", "car.obdcap.json.gz", "--profile", "vag-mqb"], directory);
    const none = await cli(["decode", "car.obdcap.json.gz"], directory);
    expect(mqb.lines[0]).toBe("decoded with profile vag-mqb");
    expect(mqb.lines.some((line) => line.includes("not in this capture"))).toBe(true);
    expect(none.lines[0]).toBe("decoded with no profile: the legislated OBD-II reads only");
    const raw = none.lines.filter((line) => /^ {2}#\d+ /.test(line));
    expect(raw.some((line) => line.includes("784 -> 785 1A86: 785 5A86"))).toBe(true);
  });

  it("refuses to overwrite a capture file, before sending anything", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "car.obdcap.json"), "kept");
    let opened = false;
    const result = await cli(
      ["capture", ...ADAPTER, "--profile", "mercedes-w211", "--output", "car.obdcap.json"],
      directory,
      {
        open: () => {
          opened = true;
          return adapterTransport(simulatedCar(W211));
        },
      },
    );
    expect(result.lines.at(-1)).toBe("error: car.obdcap.json already exists; choose a new file");
    expect(result.status).toBe(1);
    expect(await readFile(join(directory, "car.obdcap.json"), "utf8")).toBe("kept");
    expect(opened).toBe(true);
  });

  it("warns before an identifier sweep and refuses one outside its bounds", async () => {
    const directory = await workspace();
    const swept = await cli(
      [
        "capture",
        ...ADAPTER,
        "--profile",
        "mercedes-w211",
        "--output",
        "swept.obdcap.json",
        "--sweep",
        "--sweep-first",
        "0x98",
        "--sweep-last",
        "0x99",
        "--sweep-pause",
        "10",
      ],
      directory,
    );
    expect(swept.status).toBe(0);
    expect(
      swept.lines.some((line) => line.startsWith("warning: the identifier sweep sends up to 2000")),
    ).toBe(true);
    const refused = await cli(
      ["capture", ...ADAPTER, "--output", "x.obdcap.json", "--sweep", "--sweep-pause", "0"],
      directory,
    );
    expect(refused.status).toBe(1);
    expect(refused.lines.at(-1)).toMatch(/^error: identifier sweep: pauseMs /);
  });

  it("saves what it read when interrupted", async () => {
    const directory = await workspace();
    const controller = new AbortController();
    let sent = 0;
    const car = simulatedCar(W211);
    const transport = adapterTransport(car);
    const write = transport.write.bind(transport);
    transport.write = (data) => {
      sent += 1;
      if (sent === 120) controller.abort();
      return write(data);
    };
    const result = await cli(
      ["capture", ...ADAPTER, "--profile", "mercedes-w211", "--output", "cut.obdcap.json"],
      directory,
      { open: () => transport, signal: controller.signal },
    );
    expect(result.status).toBe(130);
    const capture = readCaptureFile(await readFile(join(directory, "cut.obdcap.json")), "cut");
    expect(capture.origin.complete).toBe(false);
  });

  it("refuses a file that is not a capture", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "bad.json"), '{"format":"obd-read-capture","version":2}');
    const result = await cli(["decode", "bad.json"], directory);
    expect(result.status).toBe(1);
    expect(result.lines.at(-1)).toBe(
      "error: bad.json: capture version 2 is not one this program reads (it reads 1)",
    );
    expect((await cli(["decode", "missing.json"], directory)).lines.at(-1)).toMatch(/^error: /);
  });
});

describe("obd-read import-capture", () => {
  it("imports a recorded transcript and a saved scan", async () => {
    const directory = await workspace();
    await copyFile(
      new URL("fixtures/a150-modes-01-to-09.txt", import.meta.url),
      join(directory, "a150.log"),
    );
    const imported = await cli(
      ["import-capture", "a150.log", "--output", "a150.obdcap.json"],
      directory,
    );
    expect(imported.status).toBe(0);
    expect(imported.lines).toEqual([
      "recovered 34 exchanges in 1 adapter sessions; wrote a150.obdcap.json",
    ]);
    const decoded = await cli(["decode", "a150.obdcap.json"], directory);
    expect(decoded.lines).toContain(
      "fuel system 1 status: closed loop, using oxygen sensor feedback",
    );

    await cli(["scan", ...ADAPTER, "--profile", "mercedes-w211", "--output", "scan"], directory);
    const fromScan = await cli(
      ["import-capture", "scan.json", "--output", "scan.obdcap.json"],
      directory,
    );
    expect(fromScan.status).toBe(0);
    const asW211 = await cli(
      ["decode", "scan.obdcap.json", "--profile", "mercedes-w211"],
      directory,
    );
    expect(asW211.lines.at(-1)).toMatch(/^undecoded: 0 of \d+ exchanges$/);
  });

  it("lists what a transcript holds that it cannot recover", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "odd.log"), "nonsense\n");
    const result = await cli(
      ["import-capture", "odd.log", "--output", "odd.obdcap.json"],
      directory,
    );
    expect(result.lines).toEqual([
      "not recovered: line 1: not a transcript line",
      "recovered 0 exchanges in 1 adapter sessions; wrote odd.obdcap.json",
    ]);
  });
});
