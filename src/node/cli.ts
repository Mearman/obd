/**
 * The `obd-read` command line for Node.
 *
 * Every command calls the core functions and prints what they return. This module only parses the arguments ({@link parseCommandLine}), reads and writes files ({@link FileSnapshotStore} and the other sinks in `cli-files`), opens the adapter through the transport registry, reads the broker credentials from the environment and serves `simulate` over TCP. Nothing here bypasses the guard: writes, restores, actuations and clears go through the core commands, which hold the confirmation and the single-use tokens.
 */

import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";
import { CaptureError, captureId, captureText, type Capture } from "../core/capture.js";
import { ImportError, importRecord } from "../core/capture-import.js";
import { captureFileBytes, isGzip, readCaptureFile } from "../core/capture-file.js";
import {
  DEFAULT_DISCOVERY,
  captureEverything,
  discoveryRangeSchema,
  identifierSweepSchema,
  type CaptureStep,
} from "../core/capture-run.js";
import {
  decodeCapture,
  decodedLines,
  type DecodedCapture,
  type DecodeTarget,
} from "../core/decode.js";
import type { Exchange } from "../core/exchange.js";
import {
  DECODED_VALUE_TABLE,
  EXCHANGE_TABLE,
  decodedValueRows,
  exchangeRows,
} from "../core/tabular-views.js";
import { renderTable } from "../core/tabular.js";
import { captureUnits } from "../core/storage.js";
import { randomSuffix } from "../core/time.js";
import { toolVersion } from "./version.js";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { Elm, MAX_SINGLE_FRAME, Transcript, type AdapterInfo } from "../core/elm.js";
import { pythonRepr } from "../core/format.js";
import { isCommandError } from "../core/command-errors.js";
import { batteryCommand, readVoltage } from "../core/battery.js";
import {
  CodeNameError,
  CodeNames,
  parseNamesFileText,
  parseProfileCodes,
  type CodeTable,
  type NamesFile,
} from "../core/codenames.js";
import { checkProfile, checkProfileText, profileCheckReport } from "../core/profile-check.js";
import { buildSource, liveCommand, splitNames } from "../core/live.js";
import {
  KLINE_SCHEME_NAMES,
  PROFILE_PROTOCOLS,
  ProfileError,
  parseJson,
  parseProfile,
  parseProfileText,
  type Profile,
  type ProfileProtocol,
} from "../core/profile.js";
import { KLineElm } from "../core/kline.js";
import {
  compareReport,
  describeCode,
  describeObdScan,
  describeRequests,
  describeScan,
  importNames,
  openShareLink,
  ShareLinkError,
  shareDocumentLink,
  wroteLine,
} from "../core/offline.js";
import { discoverCommand } from "../core/discovery.js";
import { clearCodesCommand } from "../core/obd-clear.js";
import { obdCommand, obdScanCommand } from "../core/obd-report.js";
import { obdReportDocument } from "../core/share.js";
import { OptionError } from "../core/options.js";
import {
  PASSWORD_VARIABLE,
  USER_VARIABLE,
  runMqtt,
  validate,
  type BrokerCredentials,
  type Connect,
  type MqttReading,
  type MqttSource,
} from "../core/mqtt.js";
import { runMonitor } from "../core/monitor.js";
import {
  printAdapter,
  profileCommand,
  type ProfileCommand,
  type ProfileCommandParams,
  type UnitReport,
} from "../core/operations.js";
import { RawCanTransport } from "../core/rawcan.js";
import { parseScan, ScanFileError } from "../core/scancompare.js";
import { simulatedCar, simulationBanner } from "../core/simulator.js";
import {
  AdapterUrlError,
  openTransport,
  TransportError,
  type Transport,
} from "../core/transport.js";
import type { LineSink } from "../core/unit-access.js";
import { loadGenericTitles } from "../data/index.js";
import { mqttJsConnect } from "../mqtt/mqtt-js-client.js";
import { builtinProfileData, builtinProfiles } from "../profiles/index.js";
import {
  discoverAdapters,
  formatAdapterListing,
  formatInspection,
  inspectDevice,
  listSystemSerialPorts,
  type SerialPortLister,
} from "./adapters.js";
import { HelpRequested, parseCommandLine, UsageError, type ParsedArgs } from "./cli-args.js";
import { PROGRAM } from "./cli-commands.js";
import {
  UNIT_VIEWS,
  describerOf,
  obdScanTable,
  tableRequest,
  unitReportsTable,
  withoutTerminator,
  type TableRequest,
} from "./cli-tables.js";
import {
  csvLogOpener,
  fileErrorText,
  FileOutputFiles,
  FileSnapshotStore,
  lineAsker,
  monitorLogFile,
  transcriptAppender,
  writeNewFile,
} from "./cli-files.js";
import { processCentral } from "./radio.js";
import { zlibShareCodec } from "./share-codec.js";
import type { BleCentral } from "./ble.js";

/** Everything the command line takes from its surroundings, so a test can supply its own. */
export interface CliIo {
  /** Prints one line to the output. */
  readonly out: LineSink;
  /** Writes text, with its own line breaks, to the error stream. */
  readonly err: (text: string) => void;
  /** Shows a prompt and returns the line the user typed. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Builds the unopened link to an adapter URL. */
  readonly open: (url: string) => Transport;
  /** The environment: only the broker credentials are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory relative file names are resolved against. */
  readonly directory: string;
  /** Opens a connection to an MQTT broker. */
  readonly connect: Connect;
  /** The host's Bluetooth LE radio, built only by the commands that need it. */
  readonly central: () => BleCentral;
  /** Lists the host's serial ports. */
  readonly listPorts: SerialPortLister;
  /** Ends `simulate` and `mqtt` when aborted, and makes other commands return status 130. */
  readonly signal?: AbortSignal;
}

/** The status a command line is stopped with by an interrupt, as the shell reports Ctrl-C. */
export const INTERRUPTED = 130;

/** The status of a command line the parser rejects. */
export const USAGE_ERROR = 2;

/** Where a profile came from: a shipped name, or a file the user named. */
type ProfileSource =
  | { readonly kind: "shipped"; readonly where: string; readonly data: unknown }
  | { readonly kind: "file"; readonly where: string; readonly text: string };

/** Reads a text file, turning a file system error into `failure(<Python-style message>)`. */
async function readText(
  io: CliIo,
  path: string,
  failure: (message: string) => Error,
): Promise<string> {
  try {
    return await readFile(resolve(io.directory, path), "utf8");
  } catch (error) {
    throw failure(`${path}: ${fileErrorText(error, path)}`);
  }
}

async function isFile(io: CliIo, path: string): Promise<boolean | undefined> {
  try {
    return (await stat(resolve(io.directory, path))).isFile();
  } catch {
    return undefined;
  }
}

/**
 * Finds a shipped profile by name, or any profile by file path.
 *
 * @throws ProfileError when neither exists.
 */
async function profileSource(io: CliIo, nameOrPath: string): Promise<ProfileSource> {
  const present = await isFile(io, nameOrPath);
  if (nameOrPath.endsWith(".json") || present !== undefined) {
    if (present !== true) throw new ProfileError([`no profile file at ${nameOrPath}`]);
    return {
      kind: "file",
      where: nameOrPath,
      text: await readFile(resolve(io.directory, nameOrPath), "utf8"),
    };
  }
  return { kind: "shipped", where: nameOrPath, data: builtinProfileData(nameOrPath) };
}

function profileJson(source: ProfileSource): unknown {
  return source.kind === "shipped" ? source.data : parseJson(source.text, source.where);
}

async function loadProfile(io: CliIo, nameOrPath: string): Promise<Profile> {
  const source = await profileSource(io, nameOrPath);
  return source.kind === "shipped"
    ? parseProfile(source.data, source.where)
    : parseProfileText(source.text, source.where);
}

/** The CAN identifier width the option parser already restricted to 11 or 29. */
function identifierBits(args: ParsedArgs): 11 | 29 {
  return args.number("idBits") === 29 ? 29 : 11;
}

function protocolOf(name: string): ProfileProtocol {
  const protocol = PROFILE_PROTOCOLS.find((candidate) => candidate === name);
  if (protocol === undefined) throw new OptionError(`unknown protocol ${pythonRepr(name)}`);
  return protocol;
}

/** Opens the adapter, runs `body` on the initialised session and closes the link on the way out. */
async function connected(
  io: CliIo,
  args: ParsedArgs,
  kline: boolean,
  body: (elm: Elm, adapter: AdapterInfo) => Promise<number>,
): Promise<number> {
  const transport = io.open(args.text("adapter"));
  await transport.open();
  try {
    const log = args.optionalText("log");
    const transcript = new Transcript(
      log === undefined ? undefined : transcriptAppender(io.directory, log),
    );
    const options = {
      transcript,
      maxRequest: transport instanceof RawCanTransport ? transport.maxRequest : MAX_SINGLE_FRAME,
    };
    const elm = kline ? new KLineElm(transport, options) : new Elm(transport, options);
    const adapter = await elm.initialise();
    return await body(elm, adapter);
  } finally {
    await transport.close();
  }
}

async function adaptersCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const timeoutMs = args.number("timeout") * 1000;
  const inspect = args.optionalText("inspect");
  if (inspect !== undefined) {
    for (const line of formatInspection(await inspectDevice(io.central(), inspect, timeoutMs))) {
      io.out(line);
    }
    return 0;
  }
  for (const line of formatAdapterListing(
    await discoverAdapters(io.central(), timeoutMs, io.listPorts),
  )) {
    io.out(line);
  }
  return 0;
}

async function monitorCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const output = args.optionalText("output");
  const log = args.optionalText("log");
  const duration = args.optionalNumber("duration");
  const count = args.optionalNumber("count");
  const sink = log === undefined ? undefined : transcriptAppender(io.directory, log);
  return runMonitor(
    {
      adapter: args.text("adapter"),
      idBits: identifierBits(args),
      bitrate: args.number("bitrate"),
      ids: args.numbers("id"),
      block: args.numbers("block"),
      flowControl: args.numbers("flowControl"),
      ...(duration === undefined ? {} : { durationMs: duration * 1000 }),
      ...(count === undefined ? {} : { count }),
      ...(output === undefined ? {} : { output: monitorLogFile(io.directory, output) }),
      ...(sink === undefined ? {} : { transcriptSink: sink }),
    },
    io.out,
    io.open,
  );
}

/** Serves a fresh simulated car to each TCP connection until `io.signal` aborts. */
async function simulateCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const profile = await loadProfile(io, args.text("profile"));
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    const car = simulatedCar(profile);
    socket.on("data", (chunk) => {
      socket.write(
        car.feed(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        ),
      );
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(args.number("port"), args.text("host"), resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TransportError("the simulator is not listening on a TCP port");
  }
  const [banner, hint] = simulationBanner(profile, address.address, address.port);
  io.out(banner);
  io.out(hint);
  await new Promise<void>((resolveStopped) => {
    if (io.signal === undefined || io.signal.aborted) {
      resolveStopped();
      return;
    }
    io.signal.addEventListener("abort", () => {
      resolveStopped();
    });
  });
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClosed) => {
    server.close(() => {
      resolveClosed();
    });
  });
  return 0;
}

async function profileCheck(io: CliIo, args: ParsedArgs): Promise<number> {
  let status = 0;
  for (const target of args.texts("targets")) {
    let source: ProfileSource;
    try {
      source = await profileSource(io, target);
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      io.out(`${target}: ${error.message}`);
      status = 1;
      continue;
    }
    const problems =
      source.kind === "shipped"
        ? checkProfile(source.data, source.where)
        : checkProfileText(source.text, source.where);
    if (problems.length > 0) status = 1;
    for (const line of profileCheckReport(source.where, problems)) io.out(line);
  }
  return status;
}

async function compareCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const load = async (path: string) =>
    parseScan(await readText(io, path, (message) => new ScanFileError(message)), path);
  const first = await load(args.text("first"));
  const second = await load(args.text("second"));
  for (const line of compareReport(first, second)) io.out(line);
  return 0;
}

async function codeNames(
  io: CliIo,
  profile: string | undefined,
  namesFiles: readonly string[],
): Promise<{ readonly names: CodeNames; readonly imported: readonly NamesFile[] }> {
  let profileCodes: ReadonlyMap<string, CodeTable> = new Map();
  if (profile !== undefined) {
    const source = await profileSource(io, profile);
    profileCodes = parseProfileCodes(profileJson(source), source.where);
  }
  const imported: NamesFile[] = [];
  for (const path of namesFiles) {
    imported.push(
      parseNamesFileText(await readText(io, path, (message) => new CodeNameError(message)), path),
    );
  }
  return { names: new CodeNames(loadGenericTitles(), profileCodes, imported), imported };
}

async function describeCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const items = args.texts("items");
  const requests = args.texts("request");
  const namesFiles = args.texts("names");
  const profile = args.optionalText("profile");
  const unit = args.optionalText("unit");
  if (items.length === 0 && requests.length === 0) {
    throw new CodeNameError("give a scan file, a fault code or --request");
  }
  for (const item of items) {
    if ((await isFile(io, item)) === true) {
      const scan = parseScan(await readText(io, item, (m) => new CodeNameError(m)), item);
      const { names } = await codeNames(io, profile ?? scan.profile, namesFiles);
      for (const line of describeScan(scan, names)) io.out(line);
      continue;
    }
    const { names } = await codeNames(io, profile, namesFiles);
    io.out(describeCode(item, unit, names));
  }
  if (requests.length > 0) {
    if (unit === undefined) throw new CodeNameError("--request needs --unit");
    const { imported } = await codeNames(io, undefined, namesFiles);
    for (const line of describeRequests(requests, unit, imported)) io.out(line);
  }
  return 0;
}

/** The names for a profile the link names, only when it is one this program ships: the link is untrusted, so it never chooses a file to read. */
function shippedNames(profile: string): CodeNames | undefined {
  if (!builtinProfiles().includes(profile)) return undefined;
  return new CodeNames(
    loadGenericTitles(),
    parseProfileCodes(builtinProfileData(profile), profile),
    [],
  );
}

async function shareCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const link = args.optionalText("open");
  const report = args.optionalText("report");
  if ((link === undefined) === (report === undefined)) {
    throw new ShareLinkError("give a report file to share, or --open with a link, not both");
  }
  const profileName = args.optionalText("profile");
  if (link !== undefined) {
    const generic = new CodeNames(loadGenericTitles(), new Map(), []);
    // The link is untrusted: the profile it names is used only when this program ships it.
    const decodeWith = async (capture: Capture): Promise<DecodeTarget> => {
      if (profileName !== undefined) {
        return { kind: "profile", profile: await loadProfile(io, profileName) };
      }
      const named = capture.origin.profile;
      return named !== null && builtinProfiles().includes(named)
        ? { kind: "profile", profile: parseProfile(builtinProfileData(named), named) }
        : { kind: "generic" };
    };
    for (const line of await openShareLink(
      link,
      zlibShareCodec,
      shippedNames,
      generic,
      decodeWith,
    )) {
      io.out(line);
    }
    return 0;
  }
  if (report === undefined) return 1;
  if (profileName !== undefined) {
    throw new ShareLinkError("--profile decodes a capture link opened with --open");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolve(io.directory, report));
  } catch (error) {
    throw new ShareLinkError(`${report}: ${fileErrorText(error, report)}`);
  }
  // A compressed capture is inflated within the capture limits; any other file is read as text.
  const text = isGzip(bytes)
    ? captureText(readCaptureFile(bytes, report))
    : new TextDecoder().decode(bytes);
  io.out(
    await shareDocumentLink(text, report, {
      base: args.text("base"),
      codec: zlibShareCodec,
      redactVin: args.flag("redactVin"),
      createdAt: Date.now(),
    }),
  );
  return 0;
}

async function importNamesCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const file = args.text("file");
  const output = args.text("output");
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(resolve(io.directory, file)));
  } catch (error) {
    throw new CodeNameError(`${file}: ${fileErrorText(error, file)}`);
  }
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const variant = args.optionalText("variant");
  const imported =
    variant === undefined
      ? importNames(data, name, args.text("unit"))
      : importNames(data, name, args.text("unit"), variant);
  const store = new FileSnapshotStore(io.directory);
  try {
    await store.create(output, `${JSON.stringify(imported.document, null, 2)}\n`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CodeNameError(`${output} already exists; choose a new file`);
    }
    throw error;
  }
  for (const line of imported.lines) io.out(line);
  io.out(wroteLine(output, name));
  return 0;
}

/** The profile commands, as the core command they run. */
function profileCommandOf(args: ParsedArgs): ProfileCommand {
  const name = args.path[0];
  switch (name) {
    case "probe":
      return { command: "probe" };
    case "scan": {
      const output = args.optionalText("output");
      return {
        command: "scan",
        freeze: args.flag("freeze"),
        ...(output === undefined ? {} : { output }),
      };
    }
    case "ident":
    case "faults":
    case "freeze":
      return { command: name, unit: args.text("unit") };
    case "request":
      return { command: "request", unit: args.text("unit"), request: args.text("hex") };
    case "clear":
      return {
        command: "clear",
        unit: args.text("unit"),
        save: args.text("save"),
        yes: args.flag("yes"),
      };
    case "write":
      return {
        command: "write",
        unit: args.text("unit"),
        save: args.text("save"),
        request: args.bytes("request"),
        read: args.bytes("read"),
      };
    case "restore":
      return {
        command: "restore",
        unit: args.text("unit"),
        save: args.text("save"),
        snapshot: args.text("snapshot"),
      };
    case "actuate":
      return {
        command: "actuate",
        unit: args.text("unit"),
        request: args.bytes("request"),
        stop: args.bytes("stop"),
        durationMs: args.number("seconds") * 1000,
      };
    default:
      throw new Error(`${String(name)} is not a profile command`);
  }
}

async function mqttCommand(
  io: CliIo,
  args: ParsedArgs,
  elm: Elm,
  adapter: AdapterInfo,
  profile: Profile | undefined,
): Promise<number> {
  const device = args.optionalText("deviceId");
  const options = {
    adapter: args.text("adapter"),
    brokerHost: args.text("brokerHost"),
    brokerPort: args.number("brokerPort"),
    tls: args.flag("tls"),
    topicPrefix: args.text("topicPrefix"),
    discoveryPrefix: args.text("discoveryPrefix"),
    ...(device === undefined ? {} : { deviceId: device }),
    intervalMs: args.number("interval") * 1000,
    count: args.number("count"),
  };
  try {
    validate(options);
  } catch (error) {
    if (error instanceof RangeError) throw new OptionError(error.message);
    throw error;
  }
  const unit = args.optionalText("unit");
  const live = await buildSource(
    elm,
    profile,
    {
      ...(unit === undefined ? {} : { unit }),
      values: splitNames(args.optionalText("values")),
      idBits: identifierBits(args),
      bitrate: args.number("bitrate"),
    },
    io.out,
  );
  const source: MqttSource = {
    columns: live.columns,
    notes: live.notes,
    read: async (out) => (await live.read(out)).map((reading): MqttReading => reading ?? null),
  };
  const credentials: {
    username?: string;
    password?: string;
  } & BrokerCredentials = {};
  const user = io.env[USER_VARIABLE];
  const password = io.env[PASSWORD_VARIABLE];
  if (user !== undefined) credentials.username = user;
  if (password !== undefined) credentials.password = password;
  try {
    return await runMqtt({
      source,
      adapter,
      options,
      connect: io.connect,
      credentials,
      ...(args.flag("noVoltage")
        ? {}
        : {
            readVoltage: async (): Promise<MqttReading> =>
              readVoltage(elm, { stn: adapter.hasStnExtensions }),
          }),
      out: io.out,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
  } catch (error) {
    if (error instanceof RangeError) throw new OptionError(error.message);
    throw error;
  }
}

/** The options a schema refused, as the command line reports them. */
function optionsOf<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new OptionError(
    `${what}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "range"} ${issue.message}`).join("; ")}`,
  );
}

/** Refuses an output file that exists before a long operation starts, so its work is not lost. */
async function requireNewFile(io: CliIo, path: string): Promise<void> {
  if ((await isFile(io, path)) !== undefined) {
    throw new OptionError(`${path} already exists; choose a new file`);
  }
}

/** The `capture` command on an open session. */
async function captureOnSession(
  io: CliIo,
  args: ParsedArgs,
  elm: Elm,
  adapter: AdapterInfo,
  profile: Profile | undefined,
): Promise<number> {
  const output = args.text("output");
  await requireNewFile(io, output);
  const discovery = optionsOf(
    discoveryRangeSchema,
    {
      first: args.number("discoverFirst"),
      last: args.number("discoverLast"),
      protocols: DEFAULT_DISCOVERY.protocols,
    },
    "discovery range",
  );
  const identifiers = args.flag("sweep")
    ? optionsOf(
        identifierSweepSchema,
        {
          first: args.number("sweepFirst"),
          last: args.number("sweepLast"),
          budget: args.number("sweepBudget"),
          pauseMs: args.number("sweepPause"),
        },
        "identifier sweep",
      )
    : undefined;
  if (identifiers !== undefined) {
    io.out(
      `warning: the identifier sweep sends up to ${String(identifiers.budget)} read requests; some units answer slowly or log the requests. Stop it with Ctrl-C and what was read is kept.`,
    );
  }
  let step: CaptureStep | undefined;
  const capture = await captureEverything(elm, {
    profile,
    discovery,
    ...(identifiers === undefined ? {} : { identifiers }),
    adapter,
    adapterUrl: args.text("adapter"),
    toolVersion: toolVersion(),
    id: captureId(Date.now(), randomSuffix()),
    progress: (progress) => {
      if (progress.step === step && progress.step === "identifiers") return;
      step = progress.step;
      io.out(progress.detail);
    },
    stopped: () => io.signal?.aborted === true,
  });
  await writeNewFile(io.directory, output, captureFileBytes(capture, args.flag("compress")));
  for (const note of capture.notes) io.out(`note: ${note}`);
  io.out(
    `captured ${String(capture.exchanges.length)} exchanges with ${String(captureUnits(capture).length)} addresses${capture.origin.complete ? "" : " (stopped before it finished)"}`,
  );
  io.out(
    `wrote ${output}; decode it with: obd-read decode ${output}${profile === undefined ? "" : ` --profile ${profile.name}`}`,
  );
  return 0;
}

async function decodeCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const path = args.text("capture");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolve(io.directory, path));
  } catch (error) {
    throw new CaptureError(fileErrorText(error, path));
  }
  const capture = readCaptureFile(bytes, path);
  const profileName = args.optionalText("profile");
  const decoded = await decodeCapture(
    capture,
    profileName === undefined
      ? { kind: "generic" }
      : { kind: "profile", profile: await loadProfile(io, profileName) },
  );
  const request = tableRequest(args, ["values", "faults", "identification", "exchanges"]);
  if (request === undefined) {
    for (const line of decodedLines(decoded)) io.out(line);
    return 0;
  }
  io.out(await decodedTable(io, request, decoded, capture.exchanges, profileName));
  return 0;
}

/** One table of a decoded capture: its values, fault codes, identification values or raw exchanges. */
async function decodedTable(
  io: CliIo,
  request: TableRequest,
  decoded: DecodedCapture,
  exchanges: readonly Exchange[],
  profileName: string | undefined,
): Promise<string> {
  if (request.view === "values") {
    return withoutTerminator(
      renderTable(request.format, DECODED_VALUE_TABLE, decodedValueRows(decoded.values, exchanges)),
    );
  }
  if (request.view === "exchanges") {
    return withoutTerminator(renderTable(request.format, EXCHANGE_TABLE, exchangeRows(exchanges)));
  }
  const { names } = await codeNames(io, profileName, []);
  const describe = describerOf(names, decoded.profile === null);
  if (decoded.profile === null) {
    return obdScanTable(request, decoded.obd, describe);
  }
  return unitReportsTable(request, decoded.units, describe);
}

async function importCaptureCommand(io: CliIo, args: ParsedArgs): Promise<number> {
  const file = args.text("file");
  const output = args.text("output");
  await requireNewFile(io, output);
  const text = await readText(io, file, (message) => new ImportError(message));
  const { capture, unrecovered } = importRecord(
    text,
    `import-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomSuffix()}`,
    file,
  );
  for (const line of unrecovered) io.out(`not recovered: ${line}`);
  await writeNewFile(io.directory, output, captureFileBytes(capture, args.flag("compress")));
  io.out(
    `recovered ${String(capture.exchanges.length)} exchanges in ${String(capture.sessions.length)} adapter sessions; wrote ${output}`,
  );
  return 0;
}

/** Runs a command that connects to an adapter. */ /** Runs a command that connects to an adapter. */
async function carCommand(io: CliIo, args: ParsedArgs, name: string): Promise<number> {
  const profileName = args.optionalText("profile");
  const usesProfile = !["obd", "discover", "clear-codes", "battery"].includes(name);
  const profile =
    usesProfile && profileName !== undefined ? await loadProfile(io, profileName) : undefined;
  const kline =
    (name === "obd" && args.optionalText("kline") !== undefined) || profile?.bus.kind === "kline";
  const store = new FileSnapshotStore(io.directory);
  const table = tableRequest(args, UNIT_VIEWS);
  if (table !== undefined && args.optionalText("output") !== undefined) {
    throw new OptionError("--format prints the table instead of writing the report; drop --output");
  }
  const csv = args.optionalText("csv");
  const tsv = args.optionalText("tsv");
  if (csv !== undefined && tsv !== undefined) {
    throw new OptionError("--csv and --tsv each write a log; give one");
  }
  const openLog =
    csv !== undefined
      ? csvLogOpener(io.directory, csv, "csv")
      : tsv !== undefined
        ? csvLogOpener(io.directory, tsv, "tsv")
        : undefined;
  // A table is machine-readable output, so the lines around it (the adapter, a profile's notes) go to standard error.
  const note = (line: string): void => {
    if (table === undefined) io.out(line);
    else io.err(`${line}\n`);
  };
  return connected(io, args, kline, async (elm, adapter) => {
    printAdapter(adapter, note);
    switch (name) {
      case "capture":
        return captureOnSession(io, args, elm, adapter, profile);
      case "live": {
        const unit = args.optionalText("unit");
        return liveCommand(
          elm,
          profile,
          {
            ...(unit === undefined ? {} : { unit }),
            values: splitNames(args.optionalText("values")),
            idBits: identifierBits(args),
            bitrate: args.number("bitrate"),
            list: args.flag("list"),
            count: args.number("count"),
            intervalMs: args.number("interval") * 1000,
            ...(openLog === undefined ? {} : { openLog }),
          },
          io.out,
        );
      }
      case "mqtt":
        return mqttCommand(io, args, elm, adapter, profile);
      case "battery": {
        const precision = args.optionalNumber("precision");
        return batteryCommand(
          elm,
          adapter,
          {
            durationMs: args.number("duration") * 1000,
            intervalMs: args.number("interval") * 1000,
            ...(precision === undefined ? {} : { precision }),
            ...(openLog === undefined ? {} : { openLog }),
          },
          io.out,
        );
      }
      case "discover": {
        const session = args.optionalNumber("session");
        const output = args.optionalText("output");
        return discoverCommand(
          elm,
          {
            protocol: protocolOf(args.text("protocol")),
            ...(session === undefined ? {} : { session }),
            bitrate: args.number("bitrate"),
            first: args.number("first"),
            last: args.number("last"),
            ...(output === undefined ? {} : { output }),
            name: args.text("name"),
            store,
            today: new Date().toISOString().slice(0, 10),
          },
          io.out,
        );
      }
      case "clear-codes":
        return clearCodesCommand({
          elm,
          adapter,
          store,
          idBits: identifierBits(args),
          bitrate: args.number("bitrate"),
          save: args.text("save"),
          yes: args.flag("yes"),
          out: io.out,
          ask: io.ask,
        });
      case "obd": {
        const scheme = KLINE_SCHEME_NAMES.find(
          (candidate) => candidate === args.optionalText("kline"),
        );
        const options = {
          idBits: identifierBits(args),
          bitrate: args.number("bitrate"),
          ...(scheme === undefined ? {} : { kline: scheme }),
        };
        const output = args.optionalText("output");
        if (table !== undefined) {
          const scan = await obdScanCommand(elm, options);
          const { names } = await codeNames(io, undefined, []);
          io.out(obdScanTable(table, scan, describerOf(names, true)));
          return 0;
        }
        if (output === undefined) return obdCommand(elm, options, io.out);
        const scan = await obdScanCommand(elm, options);
        for (const line of describeObdScan(
          scan,
          new CodeNames(loadGenericTitles(), new Map(), []),
        )) {
          io.out(line);
        }
        const document = obdReportDocument(scan, {
          takenAt: Date.now(),
          adapterLabel: adapter.identity,
        });
        await new FileOutputFiles(io.directory).write(
          output,
          `${JSON.stringify(document, null, 2)}\n`,
        );
        io.out(`wrote ${output}; share it with: obd-read share ${output} --redact-vin`);
        return 0;
      }
      default: {
        if (profile === undefined) throw new Error(`${name} needs a profile`);
        const describe =
          table === undefined
            ? undefined
            : describerOf((await codeNames(io, profileName, [])).names, false);
        const params: ProfileCommandParams = {
          elm,
          adapter,
          profile,
          store,
          files: new FileOutputFiles(io.directory),
          out: note,
          ask: io.ask,
          ...(table === undefined || describe === undefined
            ? {}
            : {
                emitUnits: (reports: readonly UnitReport[]) => {
                  io.out(unitReportsTable(table, reports, describe));
                },
              }),
        };
        return profileCommand(profileCommandOf(args), params);
      }
    }
  });
}

/** Whether the command line reports `error` as `error: ...` with status 1. */
function isReportable(error: unknown): error is Error {
  return (
    isCommandError(error) ||
    error instanceof AdapterUrlError ||
    error instanceof CodeNameError ||
    error instanceof ScanFileError ||
    error instanceof ShareLinkError ||
    error instanceof CaptureError ||
    error instanceof ImportError ||
    (error instanceof Error && error.name === "DefinitionError")
  );
}

async function dispatch(io: CliIo, args: ParsedArgs): Promise<number> {
  const name = args.path[0];
  switch (name) {
    case "adapters":
      return adaptersCommand(io, args);
    case "monitor":
      return monitorCommand(io, args);
    case "simulate":
      return simulateCommand(io, args);
    case "profile":
      return profileCheck(io, args);
    case "compare":
      return compareCommand(io, args);
    case "describe":
      return describeCommand(io, args);
    case "import-names":
      return importNamesCommand(io, args);
    case "share":
      return shareCommand(io, args);
    case "decode":
      return decodeCommand(io, args);
    case "import-capture":
      return importCaptureCommand(io, args);
    default:
      return carCommand(io, args, String(name));
  }
}

/** Waits for `signal` to abort, then resolves with {@link INTERRUPTED}. Never resolves otherwise. */
function interruption(signal: AbortSignal | undefined): Promise<number> {
  return new Promise((resolveInterrupted) => {
    if (signal === undefined) return;
    if (signal.aborted) resolveInterrupted(INTERRUPTED);
    signal.addEventListener("abort", () => {
      resolveInterrupted(INTERRUPTED);
    });
  });
}

/**
 * Runs one command line and returns its exit status: 0 for success, 1 for a command that failed or reported an error, 2 for arguments the parser rejects, 130 for an interrupt.
 *
 * Output goes to `io.out` and, for usage errors, `io.err`. A bug (an error that is not one the commands report) is thrown.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCommandLine(PROGRAM, argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.out(error.message.replace(/\n$/, ""));
      return 0;
    }
    if (error instanceof UsageError) {
      io.err(error.text);
      return USAGE_ERROR;
    }
    throw error;
  }
  // A capture stops itself at an interrupt and still writes what it read.
  const cooperative = ["simulate", "mqtt", "capture"].includes(String(args.path[0]));
  try {
    const status = await (cooperative
      ? dispatch(io, args)
      : Promise.race([dispatch(io, args), interruption(io.signal)]));
    return cooperative && io.signal?.aborted === true ? INTERRUPTED : status;
  } catch (error) {
    if (!isReportable(error)) throw error;
    io.out(`error: ${error.message}`);
    return 1;
  }
}

/** The command line's real surroundings: the process's streams, environment and registered transports. `close` releases what the command line opened (the prompt and the Bluetooth radio) so the process can exit. */
export function processIo(
  signal: AbortSignal,
  central: BleCentral = processCentral,
): { readonly io: CliIo; readonly close: () => void } {
  let asker: ReturnType<typeof lineAsker> | undefined;
  return {
    io: {
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (text) => {
        process.stderr.write(text);
      },
      ask: (prompt) => (asker ??= lineAsker(process.stdin, process.stdout)).ask(prompt),
      open: openTransport,
      env: process.env,
      directory: process.cwd(),
      connect: mqttJsConnect(),
      central: () => central,
      listPorts: listSystemSerialPorts,
      signal,
    },
    close: () => {
      asker?.close();
      central.close();
    },
  };
}

/**
 * The entry point of the `obd-read` program: runs `argv` against the process and returns the exit status. An interrupt (Ctrl-C) ends the command and gives {@link INTERRUPTED}.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  const { io, close } = processIo(controller.signal);
  try {
    return await run(argv, io);
  } finally {
    process.off("SIGINT", interrupt);
    close();
  }
}
