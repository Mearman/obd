import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAdapterUrl } from "../src/core/transport.js";
import { HelpRequested, parseCommandLine, UsageError } from "../src/node/cli-args.js";
import { COMMANDS, PROGRAM } from "../src/node/cli-commands.js";
import { lineAsker } from "../src/node/cli-files.js";
import { main, run, type CliIo } from "../src/node/cli.js";
import { tcpTransportFor } from "../src/node/tcp.js";

function io(overrides: Partial<CliIo> = {}): {
  readonly io: CliIo;
  readonly lines: string[];
  readonly errors: string[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      out: (line) => lines.push(line),
      err: (text) => errors.push(text),
      ask: () => Promise.resolve(""),
      open: (url) => tcpTransportFor(parseAdapterUrl(url)),
      env: {},
      directory: ".",
      connect: () => Promise.reject(new Error("no broker in this test")),
      central: () => {
        throw new Error("no radio in this test");
      },
      listPorts: () => Promise.resolve([]),
      ...overrides,
    },
  };
}

describe("the argument parser", () => {
  it("offers every command of the Python command line in its order, then the TypeScript-only ones", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      "monitor",
      "adapters",
      "profile",
      "simulate",
      "probe",
      "ident",
      "faults",
      "freeze",
      "scan",
      "obd",
      "live",
      "battery",
      "mqtt",
      "discover",
      "clear-codes",
      "request",
      "clear",
      "compare",
      "describe",
      "import-names",
      "write",
      "restore",
      "actuate",
      // TypeScript only: the Python tool had no captures and no sharing.
      "capture",
      "decode",
      "import-capture",
      "share",
      "record",
      "plan",
    ]);
  });

  it("takes a value that starts with a dash when it is a negative number", () => {
    const args = parseCommandLine(PROGRAM, [
      "battery",
      "--adapter",
      "tcp://x:1",
      "--duration",
      "-5",
    ]);
    expect(args.number("duration")).toBe(-5);
  });

  it("fills defaults, accepts `=` and a unique prefix", () => {
    const args = parseCommandLine(PROGRAM, ["obd", "--adap=tcp://x:1", "--bit", "250000"]);
    expect([args.number("idBits"), args.number("bitrate"), args.text("adapter")]).toEqual([
      11,
      250_000,
      "tcp://x:1",
    ]);
  });

  it("collects a repeated option and reads hexadecimal and any-base integers", () => {
    const monitor = parseCommandLine(PROGRAM, [
      "monitor",
      "--adapter",
      "a",
      "--id",
      "7e8",
      "--id",
      "0x7E1",
    ]);
    expect(monitor.numbers("id")).toEqual([0x7e8, 0x7e1]);
    const discover = parseCommandLine(PROGRAM, [
      "discover",
      "--adapter",
      "a",
      "--protocol",
      "uds",
      "--first",
      "0x700",
      "--last",
      "2047",
    ]);
    expect([discover.number("first"), discover.number("last")]).toEqual([0x700, 2047]);
  });

  it("rejects an ambiguous prefix and an option that takes no value being given one", () => {
    expect(() => parseCommandLine(PROGRAM, ["live", "--adapter", "a", "--c", "1"])).toThrow(
      /ambiguous option: --c could match --count, --csv/,
    );
    expect(() =>
      parseCommandLine(PROGRAM, ["scan", "--adapter", "a", "--profile", "p", "--freeze=1"]),
    ).toThrow(UsageError);
  });

  it("shows help for a command and for the program", () => {
    expect(() => parseCommandLine(PROGRAM, ["probe", "--help"])).toThrow(HelpRequested);
    expect(() => parseCommandLine(PROGRAM, ["-h"])).toThrow(HelpRequested);
  });

  it("has no flag for the confirmations the guard demands, nor for the broker credentials", () => {
    for (const argv of [
      [
        "write",
        "--adapter",
        "a",
        "--profile",
        "p",
        "u",
        "--request",
        "00",
        "--read",
        "00",
        "--save",
        "s",
        "--yes",
      ],
      [
        "actuate",
        "--adapter",
        "a",
        "--profile",
        "p",
        "u",
        "--request",
        "00",
        "--stop",
        "00",
        "--seconds",
        "1",
        "--yes",
      ],
      ["mqtt", "--adapter", "a", "--broker-host", "h", "--user", "u"],
      ["mqtt", "--adapter", "a", "--broker-host", "h", "--password", "p"],
    ]) {
      expect(() => parseCommandLine(PROGRAM, argv)).toThrow(/unrecognized arguments/);
    }
  });
});

describe("the confirmations", () => {
  it("read a typed line from the input and print the prompt without a line break", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const asker = lineAsker(input, output);
    const answer = asker.ask("Type yes: ");
    input.write("yes\n");
    expect(await answer).toBe("yes");
    const prompted: unknown = output.read();
    expect(String(prompted)).toBe("Type yes: ");
    input.end();
    expect(await asker.ask("Again: ")).toBe("");
    asker.close();
  });
});

describe("run", () => {
  it("returns 130 for a command interrupted before it finishes", async () => {
    const controller = new AbortController();
    controller.abort();
    const { io: surroundings } = io({ signal: controller.signal });
    expect(
      await run(
        ["probe", "--adapter", "tcp://127.0.0.1:1", "--profile", "mercedes-w211"],
        surroundings,
      ),
    ).toBe(130);
  });

  it("reports a usage error before it opens the adapter", async () => {
    const { io: surroundings, lines } = io({
      open: () => {
        throw new Error("the link must not be opened for a refused command line");
      },
    });
    expect(
      await run(
        ["clear", "x", "--adapter", "tcp://x:1", "--profile", "mercedes-w211"],
        surroundings,
      ),
    ).toBe(2);
    expect(lines).toEqual([]);
  });

  it("serves a simulated car over TCP that the command line can read", async () => {
    const controller = new AbortController();
    let announce: (line: string) => void = () => undefined;
    const banner = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const served = run(
      ["simulate", "--profile", "vag-mqb", "--port", "0"],
      io({
        signal: controller.signal,
        out: (line) => {
          if (line.startsWith("simulating")) announce(line);
        },
      }).io,
    );
    const url = /(tcp:\/\/127\.0\.0\.1:\d+)/.exec(await banner)?.[1];
    expect(url).toBeDefined();
    const probe = io();
    expect(await run(["probe", "--adapter", url ?? "", "--profile", "vag-mqb"], probe.io)).toBe(0);
    expect(probe.lines.at(-1)).toBe("9 of 9 units answered");
    controller.abort();
    expect(await served).toBe(130);
  });
});

describe("main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints to the process and returns the status", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    expect(await main(["profile", "check", "mercedes-w211"])).toBe(0);
    expect(written.join("")).toBe("mercedes-w211: ok\n");
  });
});
