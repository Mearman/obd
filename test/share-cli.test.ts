import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeShare, fragmentOfLink } from "../src/core/share.js";
import { parseAdapterUrl } from "../src/core/transport.js";
import { run, type CliIo } from "../src/node/cli.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { tcpTransportFor } from "../src/node/tcp.js";
import { FakeElmCore, fakeTransport } from "./helpers/fake-elm.js";
import { RECORDED } from "./helpers/recorded-car.js";
import { loadReplies, responder } from "./helpers/transcripts.js";

const VIN = "TESTVIN0000000001";

const REPORT = {
  tool: "obd-read",
  taken: "2026-11-15T10:00:00+00:00",
  profile: { name: "mercedes-w211", status: "provisional" },
  adapter: { identity: "ELM327 v1.5", description: null, stn_identity: null, voltage: "12.4V" },
  units: [
    {
      unit: "engine",
      description: "Engine control",
      request_id: "7E0",
      response_id: "7E8",
      answered: true,
      notes: [],
      identification: { VIN: { hex: "54455354", text: VIN } },
      faults: [{ code: "P0420", status: "2F" }],
      freeze_frames: { P0420: "00 11" },
    },
  ],
  transcript: [`< ${VIN}`],
};

const RUN_EXPORT = {
  format: "obd-read-run",
  version: 1,
  run: {
    id: "r1",
    profile: "mercedes-w211",
    adapter: "simulator://mercedes-w211",
    startedAt: 1_790_000_000_000,
    stoppedAt: 1_790_000_003_000,
    notes: "",
  },
  samples: [0, 1, 2, 3].map((index) => ({
    runId: "r1",
    signal: "engine speed",
    unit: "rpm",
    timestamp: 1_790_000_000_000 + index * 1000,
    value: 700 + index * 100,
  })),
};

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "obd-share-"));
  await writeFile(join(directory, "scan.json"), JSON.stringify(REPORT));
  await writeFile(join(directory, "run.json"), JSON.stringify(RUN_EXPORT));
  await writeFile(join(directory, "broken.json"), "{nope");
  return directory;
}

async function share(
  argv: readonly string[],
  open?: CliIo["open"],
  directoryOf?: string,
): Promise<{
  readonly status: number;
  readonly lines: string[];
  readonly errors: string[];
  readonly directory: string;
}> {
  const lines: string[] = [];
  const errors: string[] = [];
  const directory = directoryOf ?? (await workspace());
  const io: CliIo = {
    out: (line) => lines.push(line),
    err: (text) => errors.push(text),
    ask: () => Promise.resolve(""),
    open: open ?? ((url) => tcpTransportFor(parseAdapterUrl(url))),
    env: {},
    directory,
    connect: () => Promise.reject(new Error("no broker in this test")),
    central: () => {
      throw new Error("no radio in this test");
    },
    listPorts: () => Promise.resolve([]),
  };
  return { status: await run(argv, io), lines, errors, directory };
}

async function decoded(link: string | undefined) {
  const fragment = link === undefined ? undefined : fragmentOfLink(link);
  if (fragment === undefined) throw new Error("no share fragment");
  const result = await decodeShare(fragment, zlibShareCodec);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("share", () => {
  it("prints a link under the default app address that carries the scan without its transcript", async () => {
    const { status, lines } = await share(["share", "scan.json"]);
    expect(status).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^https:\/\/mearman\.github\.io\/obd\/#share=1\./);
    const envelope = await decoded(lines[0]);
    expect(envelope.kind).toBe("scan");
    const text = JSON.stringify(envelope);
    expect(text).toContain(VIN);
    expect(text).not.toContain("transcript");
  });

  it("blanks the VIN with --redact-vin and uses --base", async () => {
    const { status, lines } = await share([
      "share",
      "scan.json",
      "--redact-vin",
      "--base",
      "http://localhost:4173/",
    ]);
    expect(status).toBe(0);
    expect(lines[0]).toMatch(/^http:\/\/localhost:4173\/#share=1\./);
    expect(JSON.stringify(await decoded(lines[0]))).not.toContain(VIN);
  });

  it("shares a run export as a summary", async () => {
    const { status, lines } = await share(["share", "run.json"]);
    expect(status).toBe(0);
    const envelope = await decoded(lines[0]);
    expect(envelope.kind).toBe("run-summary");
    if (envelope.kind === "run-summary") {
      expect(envelope.data.signals[0]).toMatchObject({
        signal: "engine speed",
        min: 700,
        max: 1000,
        mean: 850,
      });
      expect(envelope.data.signals[0]?.series).toHaveLength(4);
    }
  });

  it("opens a link and prints the scan in the describe format", async () => {
    const made = await share(["share", "scan.json", "--redact-vin"]);
    const link = made.lines[0] ?? "";
    const { status, lines } = await share(["share", "--open", link]);
    expect(status).toBe(0);
    expect(lines[0]).toMatch(/^shared data, not read from an adapter; link made 20/);
    expect(lines).toContain("VIN and serial numbers were removed before sharing");
    expect(lines).toContain("shared link (taken 2026-11-15T10:00:00+00:00, profile mercedes-w211)");
    expect(lines.some((line) => line.startsWith("  engine P0420 status 2F: "))).toBe(true);
    expect(lines.join("\n")).not.toContain(VIN);
  });

  it("opens a run summary link", async () => {
    const made = await share(["share", "run.json"]);
    const { status, lines } = await share(["share", "--open", made.lines[0] ?? ""]);
    expect(status).toBe(0);
    expect(lines.join("\n")).toMatch(
      /engine speed \(rpm\): 4 readings, min 700, max 1000, mean 850, 4 series points/,
    );
  });

  it("reports a bad file, a bad link and a wrong argument count with status 1", async () => {
    for (const argv of [
      ["share", "broken.json"],
      ["share", "missing.json"],
      ["share", "--open", "https://example.com/#share=1.!!!"],
      ["share", "--open", "https://example.com/"],
      ["share"],
      ["share", "scan.json", "--open", "https://example.com/#share=1.abc"],
    ]) {
      const { status, lines } = await share(argv);
      expect(status, argv.join(" ")).toBe(1);
      expect(lines[0], argv.join(" ")).toMatch(/^error: /);
    }
  });
});

describe("a generic OBD-II read from the recorded car", () => {
  const recordedCar: CliIo["open"] = () =>
    fakeTransport(new FakeElmCore({ 0x7df: responder(loadReplies(...RECORDED)) }));

  it("is written by obd --output, shared with --redact-vin and opened again", async () => {
    const read = await share(
      ["obd", "--adapter", "tcp://car:1", "--output", "read.json"],
      recordedCar,
    );
    const link = await share(["share", "read.json", "--redact-vin"], undefined, read.directory);
    const opened = await share(["share", "--open", link.lines[0] ?? ""], undefined, read.directory);
    expect([read.status, link.status, opened.status]).toEqual([0, 0, 0]);
    expect(read.lines).toContain("  calibration identifiers: 0034466040150284");
    expect(read.lines.at(-1)).toBe(
      "wrote read.json; share it with: obd-read share read.json --redact-vin",
    );
    const envelope = await decoded(link.lines[0]);
    expect(envelope.kind).toBe("obd-report");
    expect(JSON.stringify(envelope)).not.toContain("0034466040150284");
    expect(opened.lines[0]).toMatch(/^shared data, not read from an adapter; link made 20/);
    expect(opened.lines).toContain("VIN and calibration identifiers were removed before sharing");
    expect(opened.lines).toContain("  calibration identifiers: (removed)");
    expect(opened.lines).toContain("short-term fuel trim bank 1 from 7E8: -2.344 %");
    expect(opened.lines.join("\n")).not.toContain("0034466040150284");
  });

  it("is shared without redaction when --redact-vin is not given", async () => {
    const read = await share(
      ["obd", "--adapter", "tcp://car:1", "--output", "read.json"],
      recordedCar,
    );
    const link = await share(["share", "read.json"], undefined, read.directory);
    expect(JSON.stringify(await decoded(link.lines[0]))).toContain("0034466040150284");
  });

  it("is refused by share when the file is not an OBD-II read", async () => {
    const directory = await workspace();
    await writeFile(
      join(directory, "bad.json"),
      JSON.stringify({ tool: "obd-read", format: "obd-report" }),
    );
    const { status, lines } = await share(["share", "bad.json"], undefined, directory);
    expect(status).toBe(1);
    expect(lines[0]).toMatch(/^error: bad\.json: not a saved OBD-II read/);
  });
});
