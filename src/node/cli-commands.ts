/**
 * The `obd-read` commands as declarative specs: each argument's name, conversion, choices, default and help, in the order the Python command line declared them (the order decides how a missing argument is listed, and the order commands are offered in an unknown-command error).
 */

import { ACTUATION_MAX_MS } from "../core/guard.js";
import { KLINE_SCHEME_NAMES } from "../core/profile.js";
import { builtinProfiles } from "../profiles/index.js";
import type { ArgSpec, CommandSpec, OptionSpec, PositionalSpec } from "./cli-args.js";

const ID_BITS = [11, 29] as const;
const BITRATES = [250_000, 500_000] as const;

function option(
  flag: string,
  kind: OptionSpec["kind"],
  help: string,
  extra: Partial<OptionSpec> = {},
): OptionSpec {
  const dest = flag.slice(2).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return { flag, dest, kind, help, ...extra };
}

function positional(
  dest: string,
  help: string,
  count: PositionalSpec["count"] = "one",
  extra: Partial<PositionalSpec> = {},
): PositionalSpec {
  return { dest, kind: "string", count, help, ...extra };
}

/** A command that connects to an adapter: `--adapter`, `--log` and, unless told otherwise, `--profile`. */
function car(
  name: string,
  summary: string,
  args: readonly ArgSpec[] = [],
  withProfile = true,
): CommandSpec {
  return {
    name,
    summary,
    args: [
      option(
        "--adapter",
        "string",
        "adapter URL: ble://<name or address>, serial://<device>, tcp://<host>:<port>",
        {
          required: true,
        },
      ),
      option("--log", "string", "append the full adapter transcript to this file"),
      ...(withProfile
        ? [
            option(
              "--profile",
              "string",
              `profile name (${builtinProfiles().join(", ")}) or path to a .json file`,
              { required: true },
            ),
          ]
        : []),
      ...args,
    ],
  };
}

function idBits(): OptionSpec {
  return option("--id-bits", "int", "CAN identifier width in bits", {
    choices: ID_BITS,
    default: 11,
  });
}

function bitrate(choices: boolean): OptionSpec {
  return option("--bitrate", "int", "CAN bit rate in bit/s", {
    ...(choices ? { choices: BITRATES } : {}),
    default: 500_000,
  });
}

/** The arguments that choose what a live-style command reads. */
function sourceOptions(): ArgSpec[] {
  return [
    positional(
      "unit",
      "a unit in --profile; omit to read the legislated OBD-II values",
      "optional",
    ),
    option("--profile", "string", "profile name or path; needed to name a unit"),
    option("--values", "string", "comma-separated value names; default is every value"),
    idBits(),
    bitrate(true),
  ];
}

const UNIT = (): PositionalSpec => positional("unit", "a unit name from the profile");

const SAVE = (help: string): OptionSpec => option("--save", "string", help, { required: true });

const YES = (): OptionSpec => option("--yes", "flag", "do not ask before clearing");

/** The commands, in the order the command line offers them. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "monitor",
    summary: "log CAN traffic without transmitting",
    description:
      "Log CAN traffic without transmitting. Through a raw CAN adapter the log is complete; " +
      "through an ELM327-style adapter it holds what the adapter's filters pass.",
    args: [
      option("--adapter", "string", "adapter URL, as for the other commands", { required: true }),
      idBits(),
      bitrate(true),
      option("--id", "hexInt", "keep only this identifier (hexadecimal); repeat for several", {
        repeat: true,
      }),
      option("--block", "hexInt", "drop this identifier (hexadecimal); repeat for several", {
        repeat: true,
      }),
      option(
        "--flow-control",
        "hexInt",
        "also keep this flow-control identifier (hexadecimal); repeat for several",
        { repeat: true },
      ),
      option("--duration", "float", "stop after this many seconds"),
      option("--count", "int", "stop after this many frames"),
      option("--output", "string", "write the log to this new file"),
      option("--log", "string", "append the adapter transcript to this file"),
    ],
  },
  {
    name: "adapters",
    summary: "list Bluetooth LE devices and serial ports",
    args: [
      option("--inspect", "string", "show one Bluetooth LE device's services", {
        metavar: "NAME",
      }),
      option("--timeout", "float", "scan time in seconds", { default: 8 }),
    ],
  },
  {
    name: "profile",
    summary: "work with vehicle profiles",
    args: [],
    subcommands: [
      {
        name: "check",
        summary: "validate profile files without connecting to anything",
        args: [
          positional("targets", "a profile name or .json path", "one-or-more", {
            metavar: "PROFILE",
          }),
        ],
      },
    ],
  },
  {
    name: "simulate",
    summary: "serve a scripted adapter and car over TCP, for use without a car",
    description:
      "Serve a scripted ELM327 adapter and car over TCP, so the tool and a profile can be tried " +
      "without a car. Nothing is connected to.",
    args: [
      option("--profile", "string", "profile whose units the car has", { required: true }),
      option("--host", "string", "address to listen on", { default: "127.0.0.1" }),
      option("--port", "int", "port to listen on (0 picks one)", { default: 35_000 }),
    ],
  },
  car("probe", "ask every unit in the profile to identify itself"),
  car("ident", "read one unit's identification", [UNIT()]),
  car("faults", "read one unit's stored fault codes", [UNIT()]),
  car("freeze", "read the freeze frame stored with each fault code", [UNIT()]),
  car("scan", "read identification and fault codes from every unit", [
    option("--output", "string", "write <output>.json and <output>.md"),
    option("--freeze", "flag", "also read freeze frames"),
  ]),
  car(
    "obd",
    "legislated OBD-II reads; needs no profile",
    [
      option("--id-bits", "int", "CAN identifier width in bits", { choices: ID_BITS, default: 11 }),
      bitrate(false),
      option("--kline", "string", "read over K-line with this initialisation instead of CAN", {
        choices: KLINE_SCHEME_NAMES,
      }),
      option(
        "--output",
        "string",
        "read once as structured data, print it and write it to this JSON file, which share turns into a link (TypeScript only)",
      ),
    ],
    false,
  ),
  car(
    "live",
    "read named live values once or repeatedly, optionally logging to CSV",
    [
      ...sourceOptions(),
      option("--list", "flag", "list the value names and stop"),
      option("--count", "int", "how many samples to take", { default: 1 }),
      option("--interval", "float", "seconds between samples", { default: 1 }),
      option("--csv", "string", "write each sample to this new CSV file"),
    ],
    false,
  ),
  car(
    "battery",
    "log the adapter's voltage reading at a fixed interval; needs no profile or car bus",
    [
      option("--duration", "float", "seconds to keep sampling", { default: 60 }),
      option("--interval", "float", "seconds between samples", { default: 0.25 }),
      option("--precision", "int", "decimals to ask for from an adapter that has STVR"),
      option("--csv", "string", "write each sample to this new CSV file"),
    ],
    false,
  ),
  car(
    "mqtt",
    "publish live values and the adapter voltage to an MQTT broker, for Home Assistant",
    [
      ...sourceOptions(),
      option("--broker-host", "string", "MQTT broker host name or address", { required: true }),
      option("--broker-port", "int", "MQTT broker port", { default: 1883 }),
      option("--tls", "flag", "connect to the broker over TLS"),
      option("--topic-prefix", "string", "prefix of the state topics", { default: "obd-read" }),
      option("--discovery-prefix", "string", "Home Assistant's MQTT discovery prefix", {
        default: "homeassistant",
      }),
      option(
        "--device-id",
        "string",
        "identifier of the Home Assistant device; default is derived from --adapter",
      ),
      option("--interval", "float", "seconds between samples", { default: 10 }),
      option("--count", "int", "samples to publish; 0 keeps going until interrupted", {
        default: 0,
      }),
      option("--no-voltage", "flag", "do not publish the adapter's voltage reading"),
    ],
    false,
  ),
  car(
    "discover",
    "sweep CAN request identifiers for units that answer a session request",
    [
      option("--protocol", "string", "the diagnostic protocol to ask with", {
        choices: ["kwp2000", "uds"],
        required: true,
      }),
      option("--session", "autoInt", "default per protocol"),
      option("--bitrate", "int", "CAN bit rate in bit/s", { choices: BITRATES, default: 500_000 }),
      option("--first", "autoInt", "the first request identifier to try", { default: 0x700 }),
      option("--last", "autoInt", "the last request identifier to try", { default: 0x7ff }),
      option("--output", "string", "write a draft profile to this new file"),
      option("--name", "string", "name for the draft profile", { default: "discovered" }),
    ],
    false,
  ),
  car(
    "clear-codes",
    "save, then erase, every emissions unit's codes; needs no profile",
    [idBits(), bitrate(true), SAVE("new file for the snapshot"), YES()],
    false,
  ),
  car("request", "send one read-only request, given as hexadecimal bytes", [
    UNIT(),
    positional("hex", "request bytes, for example 1A86"),
  ]),
  car("clear", "save, then erase, one unit's stored fault codes", [
    UNIT(),
    SAVE("new file for the snapshot"),
    YES(),
  ]),
  {
    name: "compare",
    summary: "compare two saved scans",
    description:
      "Report, per unit, which fault codes appeared, cleared or changed status, and which units " +
      "started or stopped answering.",
    args: [
      positional("first", "the earlier scan (.json from scan --output)"),
      positional("second", "the later scan"),
    ],
  },
  {
    name: "describe",
    summary: "name fault codes from a saved scan or given on the command line",
    description:
      "Each item is a saved scan, or a fault code: an SAE code such as P0420 (generic list) or " +
      "hexadecimal bytes with --unit (the profile's table, then --names).",
    args: [
      positional("items", "saved scan files and fault codes", "any"),
      option(
        "--profile",
        "string",
        "profile name or path; a scan's own profile is used when omitted",
      ),
      option("--unit", "string", "the unit that reported the hexadecimal codes given"),
      option("--names", "string", "a file from import-names", { repeat: true }),
      option("--request", "string", "name a request, from --names", {
        repeat: true,
        metavar: "HEX",
      }),
    ],
  },
  {
    name: "import-names",
    summary: "import code and request names from a definition file you supply",
    description:
      "Read fault-code texts and request names from an ODX file, a PDX archive or the JSON Trafo " +
      "(CaesarSuite) writes for a CBF file, and save them for one unit. Nothing from the file is " +
      "kept anywhere else.",
    args: [
      positional("file", ".odx, .odx-d, .xml, .pdx or Trafo .json"),
      option("--unit", "string", "the profile unit these names belong to", { required: true }),
      option("--output", "string", "new names file to write", { required: true }),
      option("--variant", "string", "read only the diagnostic layer or variant of this name"),
    ],
  },
  car("write", "save the current value, then write one coding or adaptation value", [
    UNIT(),
    option("--request", "bytes", "the write request, as hexadecimal", { required: true }),
    option(
      "--read",
      "bytes",
      "the request that reads the identifier the write names, as hexadecimal",
      { required: true },
    ),
    SAVE("new file for the snapshot"),
  ]),
  car("restore", "write back the previous value a write snapshot saved", [
    UNIT(),
    option("--snapshot", "string", "the snapshot a write command saved", { required: true }),
    SAVE("new file for this restore's own snapshot"),
  ]),
  car("actuate", "drive one actuator for a bounded time, then hand control back to the unit", [
    UNIT(),
    option("--request", "bytes", "the start request, as hexadecimal", { required: true }),
    option("--stop", "bytes", "the request that returns control to the unit, as hexadecimal", {
      required: true,
    }),
    option(
      "--seconds",
      "float",
      `how long to hold control, at most ${String(ACTUATION_MAX_MS / 1000)}`,
      { required: true },
    ),
  ]),
  car(
    "capture",
    "record every raw request and reply through the read-only services, to decode later under any profile (TypeScript only)",
    [
      option(
        "--profile",
        "string",
        "profile whose units to read (name or .json path); without one, sweep for units",
      ),
      option("--output", "string", "the new capture file to write (.obdcap.json)", {
        required: true,
      }),
      option("--compress", "flag", "write the capture gzip-compressed (.obdcap.json.gz)"),
      option(
        "--discover-first",
        "autoInt",
        "without a profile, the first request identifier to try",
        {
          default: 0x700,
        },
      ),
      option(
        "--discover-last",
        "autoInt",
        "without a profile, the last request identifier to try",
        {
          default: 0x7ff,
        },
      ),
      option(
        "--sweep",
        "flag",
        "also read every data identifier in a range on each unit that answered: many requests, off by default",
      ),
      option("--sweep-first", "autoInt", "the first identifier the sweep reads", { default: 0 }),
      option("--sweep-last", "autoInt", "the last identifier the sweep reads", { default: 0xff }),
      option("--sweep-budget", "int", "the most requests the sweep sends", { default: 2000 }),
      option("--sweep-pause", "int", "milliseconds between two sweep requests", { default: 50 }),
    ],
    false,
  ),
  {
    name: "decode",
    summary: "print what a capture says under a profile, or under none (TypeScript only)",
    description:
      "Decode a capture file (capture --output, or import-capture --output) under a profile, or under none for the legislated OBD-II reads only. Nothing is sent to a car. Every exchange no reader decodes is listed with its raw bytes.",
    args: [
      positional("capture", "the capture file (.obdcap.json or .obdcap.json.gz)"),
      option("--profile", "string", "profile name or path to a .json file; omitted, no profile"),
    ],
  },
  {
    name: "import-capture",
    summary: "turn a saved scan or an adapter transcript into a capture file (TypeScript only)",
    description:
      "Recover the raw exchanges of a saved scan (scan --output, from its transcript) or an adapter transcript (--log) and write them as a capture, listing what could not be recovered.",
    args: [
      positional("file", "a saved scan .json or a --log transcript"),
      option("--output", "string", "the new capture file to write", { required: true }),
      option("--compress", "flag", "write the capture gzip-compressed"),
    ],
  },
  {
    name: "share",
    summary:
      "make a link that shares a saved scan, OBD-II read, run or capture, or read one (TypeScript only)",
    description:
      "Print a link whose #share= fragment carries a saved scan (scan --output), a generic OBD-II " +
      "read (obd --output), a run's JSON export or a raw capture (.obdcap.json or .obdcap.json.gz), compressed. The fragment is never sent to a server, but anyone holding the link can " +
      "read the fault history in it. With --open, print what a link carries in the format describe " +
      "uses; a capture is decoded as decode prints it. This command has no Python equivalent.",
    args: [
      positional(
        "report",
        "the saved scan, OBD-II read, run export or capture to share",
        "optional",
      ),
      option(
        "--redact-vin",
        "flag",
        "blank the VIN, serial numbers and calibration identifiers before sharing, in a capture's raw bytes too",
      ),
      option(
        "--profile",
        "string",
        "with --open, the profile to decode a capture link with: a name or a .json file; omitted, the profile the capture names when it is shipped, else none",
      ),
      option("--base", "string", "the app's address", {
        default: "https://mearman.github.io/obd/",
      }),
      option("--open", "string", "a share link to read instead of making one", { metavar: "LINK" }),
    ],
  },
];

/** The program: the commands under the name the command line is run as. */
export const PROGRAM: CommandSpec = {
  name: "obd-read",
  summary: "Read vehicle diagnostics through ELM327-style adapters.",
  args: [],
  subcommands: COMMANDS,
};
