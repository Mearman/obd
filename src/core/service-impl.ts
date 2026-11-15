/**
 * The in-process implementation of {@link diagnosticsContract} over {@link Storage}, a {@link DeviceLink} and a {@link Collector}.
 *
 * This is the service an edge hosts: the UI's own process calls {@link DiagnosticsHost.client} directly, a dedicated worker serves {@link DiagnosticsHost.router} over a message port, and a Node daemon serves it over a socket. The guard runs here, inside the commands the handlers call (`profileCommand`, `clearCodesCommand`), so no client can bypass it and no client holds a token. Operations that change the car are parked between their request and their confirmation by {@link PendingConfirmations}.
 */

import { ORPCError, createRouterClient, implement, type RouterClient } from "@orpc/server";
import {
  diagnosticsContract,
  type AdapterCapability,
  type Connection,
  type DiagnosticsContract,
  type DecodedCaptureData,
  type GuardedRequestData,
  type UnitReportData,
} from "./service.js";
import { ActuationError } from "./actuate.js";
import { asciiEncode, toUpperHex } from "./bytes.js";
import { readThroughCapture } from "./captured-read.js";
import {
  GENERIC_PROFILE,
  PROFILE_REQUIRED_CODE,
  ProfileRequired,
  profileLabel,
  requireProfile,
  sessionBus,
} from "./generic.js";
import { FUNCTIONAL_ID } from "./obd.js";
import { readObdScan, type ObdScan } from "./obd-scan.js";
import { readVoltage } from "./battery.js";
import type { Collector, SampleSink } from "./collector.js";
import type { DeviceLink } from "./device-link.js";
import { LinkBusy, NotConnected, type LinkSession } from "./device-link.js";
import { NegativeResponse } from "./diag.js";
import { ElmError } from "./elm.js";
import {
  ConfirmationPending,
  PendingConfirmations,
  UnknownConfirmation,
  type GuardedKind,
} from "./guarded.js";
import { GuardError } from "./guard.js";
import { runMonitor } from "./monitor.js";
import { jsonText } from "./ordered-json.js";
import { OptionError } from "./options.js";
import {
  ClearRefused,
  readUnit,
  requestBytes,
  scan,
  scanDocument,
  type UnitReport,
  profileCommand,
} from "./operations.js";
import { clearCodesCommand } from "./obd-clear.js";
import { ProfileError, parseJson, parseProfile, profileUnit, type Profile } from "./profile.js";
import { CaptureError } from "./capture.js";
import { CaptureBusy, CaptureJobs } from "./capture-jobs.js";
import { ImportError, importRecord } from "./capture-import.js";
import { decodeCapture, decodedLines, type DecodeTarget, type DecodedCapture } from "./decode.js";
import { decodeAsOf } from "./playback.js";
import { checkProfile } from "./profile-check.js";
import {
  RunImportError,
  exportRunDelimitedText,
  exportRunJson,
  importRunTable,
} from "./run-export.js";
import { FORMAT_FILES, TabularError } from "./tabular.js";
import {
  readSelection,
  recordedPlan,
  userNotes,
  withPlan,
  withSelection,
} from "./run-selection.js";
import { PlanError, parsePlanText, type Plan } from "./plan.js";
import { PlanBusy, PlanJobs } from "./plan-jobs.js";
import { planRunNotes, systemClock, type PlanClock } from "./plan-runner.js";
import { isSimulatorUrl } from "./simulator-host.js";
import { StorageSnapshotStore } from "./snapshot-store.js";
import { isoNowSeconds, now as clockNow, randomSuffix, sleep as realSleep } from "./time.js";
import {
  StorageError,
  allowsWrites,
  jsonSchema,
  type Run,
  type Sample,
  type Storage,
} from "./storage.js";
import { AdapterUrlError, SCHEMES, TransportError, type Scheme } from "./transport.js";
import type { DeviceGrants } from "./transport-host.js";
import { type TransportHost } from "./transport-host.js";
import { WriteRefused } from "./writes.js";

/** What {@link createDiagnosticsHost} needs from its edge. */
export interface DiagnosticsDependencies {
  readonly storage: Storage;
  readonly collector: Collector;
  /** The connection the operations share with the collector. */
  readonly link: DeviceLink;
  /** What the capability listing and the monitor build transports from. */
  readonly transports: TransportHost;
  /** The devices a page's picker granted, for transports that run in a worker. */
  readonly grants: DeviceGrants;
  /** The clock for run, snapshot and confirmation times; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Waits during an actuator test; defaults to a timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** How long a clear, write or actuator request waits for its confirmation, in milliseconds. */
  readonly confirmationTtlMs?: number;
  /** Finds a shipped or imported profile by name, for decoding a capture; rejects when there is none. */
  readonly loadProfile: (name: string) => Promise<Profile>;
  /** The program's version, as captures record it. */
  readonly toolVersion: string;
  /** The shipped recording plans. */
  readonly plans: PlanCatalogue;
  /** Time and waiting for recording plans; defaults to the real clock. */
  readonly planClock?: PlanClock;
  /** The gap between reads of the fault code lists while a plan's phase watches them; defaults to the runner's. */
  readonly planCodesIntervalMs?: number;
}

/** The recording plans an edge ships, as `obd-read/plans` gives them. */
export interface PlanCatalogue {
  /** The shipped plans' names. */
  readonly names: () => readonly string[];
  /**
   * A shipped plan by name.
   *
   * @throws PlanError when there is no such plan, naming the shipped ones.
   */
  readonly load: (name: string) => Plan;
}

/** How long a guarded request waits for its confirmation unless the edge says otherwise, in milliseconds. */
export const CONFIRMATION_TTL_MS = 120_000;

/** The most samples a live subscriber may have waiting before it is ended as too slow. */
export const LIVE_SUBSCRIBER_BUFFER = 10_000;

/** A live subscriber stopped reading and fell more than {@link LIVE_SUBSCRIBER_BUFFER} samples behind. */
export class LiveSubscriberOverflow extends Error {
  override name = "LiveSubscriberOverflow";
}

interface Subscriber {
  readonly runId: string | undefined;
  readonly queue: Sample[];
  wake: (() => void) | undefined;
  overflowed: boolean;
}

/** The part of an `AbortSignal` the live fan-out uses; core has no DOM types, and a real `AbortSignal` satisfies it. */
interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { readonly once: boolean }): void;
}

/** Fans collected samples out to the subscribers of `live.samples`. */
class LiveHub {
  private readonly subscribers = new Set<Subscriber>();

  publish(samples: readonly Sample[]): void {
    for (const subscriber of this.subscribers) {
      for (const sample of samples) {
        if (subscriber.runId !== undefined && sample.runId !== subscriber.runId) continue;
        if (subscriber.queue.length >= LIVE_SUBSCRIBER_BUFFER) {
          subscriber.overflowed = true;
          break;
        }
        subscriber.queue.push(sample);
      }
      subscriber.wake?.();
    }
  }

  /** Yields samples as they are published until `signal` aborts or the consumer stops iterating. */
  async *subscribe(
    runId: string | undefined,
    signal: AbortLike | undefined,
  ): AsyncGenerator<Sample> {
    const subscriber: Subscriber = { runId, queue: [], wake: undefined, overflowed: false };
    this.subscribers.add(subscriber);
    const onAbort = (): void => {
      subscriber.wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (signal?.aborted !== true) {
        const next = subscriber.queue.shift();
        if (next !== undefined) {
          yield next;
        } else if (subscriber.overflowed) {
          throw new LiveSubscriberOverflow(
            `live samples fell more than ${String(LIVE_SUBSCRIBER_BUFFER)} behind`,
          );
        } else {
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
          subscriber.wake = undefined;
        }
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}

const SCHEME_FACTS: Readonly<
  Record<Scheme, Pick<AdapterCapability, "platform" | "userPicksDevice" | "description">>
> = {
  ble: {
    platform: "node",
    userPicksDevice: false,
    description: "Bluetooth LE adapter by name or address",
  },
  serial: {
    platform: "node",
    userPicksDevice: false,
    description: "USB or Bluetooth serial adapter by device path",
  },
  tcp: { platform: "node", userPicksDevice: false, description: "Wi-Fi adapter by host and port" },
  socketcan: { platform: "node", userPicksDevice: false, description: "SocketCAN interface" },
  slcan: {
    platform: "node",
    userPicksDevice: false,
    description: "SLCAN adapter on a serial device",
  },
  webserial: {
    platform: "browser",
    userPicksDevice: true,
    description: "USB or Bluetooth serial adapter chosen in the browser",
  },
  webbluetooth: {
    platform: "browser",
    userPicksDevice: true,
    description: "Bluetooth LE adapter chosen in the browser",
  },
  webusb: {
    platform: "browser",
    userPicksDevice: true,
    description: "WebUSB adapter chosen in the browser",
  },
};

/** Every adapter scheme with whether `served` includes it. */
export function listAdapterCapabilities(served: readonly Scheme[]): AdapterCapability[] {
  const registered = new Set(served);
  return SCHEMES.map((scheme) => ({
    scheme,
    ...SCHEME_FACTS[scheme],
    available: registered.has(scheme),
  }));
}

const STORAGE_ERROR_CODES = {
  "not-found": "NOT_FOUND",
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
} as const;

/** The oRPC error a failure a caller can act on becomes, or `undefined` for a failure that is a bug. */
function callerError(error: unknown): ORPCError<string, undefined> | undefined {
  if (error instanceof StorageError) {
    return new ORPCError(STORAGE_ERROR_CODES[error.code], { message: error.message });
  }
  if (error instanceof ProfileRequired) {
    return new ORPCError(PROFILE_REQUIRED_CODE, { message: error.message });
  }
  if (
    error instanceof ProfileError ||
    error instanceof OptionError ||
    error instanceof AdapterUrlError ||
    error instanceof CaptureError ||
    error instanceof ImportError ||
    error instanceof RunImportError ||
    error instanceof TabularError ||
    error instanceof PlanError
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof GuardError) return new ORPCError("FORBIDDEN", { message: error.message });
  if (
    error instanceof ClearRefused ||
    error instanceof WriteRefused ||
    error instanceof LinkBusy ||
    error instanceof ConfirmationPending ||
    error instanceof CaptureBusy ||
    error instanceof PlanBusy
  ) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof NotConnected) {
    return new ORPCError("PRECONDITION_FAILED", { message: error.message });
  }
  if (error instanceof UnknownConfirmation) {
    return new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (
    error instanceof TransportError ||
    error instanceof ElmError ||
    error instanceof NegativeResponse ||
    error instanceof ActuationError
  ) {
    return new ORPCError("BAD_GATEWAY", { message: error.message });
  }
  return undefined;
}

/** Runs `work`, turning the errors a caller can act on into oRPC errors with the matching code. */
/** The profile an imported run is stored under, as a run's file does not name one. */
const IMPORTED_RUN_PROFILE = "imported-file";

async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw callerError(error) ?? error;
  }
}

function unitReportData(report: UnitReport): UnitReportData {
  return {
    unit: report.unit,
    description: report.description,
    requestId: report.requestId,
    responseId: report.responseId,
    answered: report.answered,
    notes: report.notes,
    identification: Array.from(report.identification, ([label, value]) => ({
      label,
      hex: value.hex,
      text: value.text,
    })),
    faults: report.faults === null ? null : report.faults.map((fault) => ({ ...fault })),
    freezeFrames: Object.fromEntries(report.freezeFrames),
  };
}

function connectionData(session: LinkSession): Connection {
  return {
    profile: session.profile?.name ?? null,
    adapter: session.adapterUrl,
    simulated: isSimulatorUrl(session.adapterUrl),
    info: { ...session.adapter },
  };
}

const SCAN_STATUSES = [
  ["stored", "stored"],
  ["pending", "pending"],
  ["permanent", "permanent"],
] as const;

/** One report per emissions unit that answered the legislated reads, in the shape a unit scan has, so a caller shows both the same way. The VIN is carried by the first unit. */
function obdUnitReports(scan: ObdScan, requestId: string): UnitReportData[] {
  return scan.units.map((unit, index) => {
    const found = SCAN_STATUSES.flatMap(([kind, status]) =>
      (unit[kind] ?? []).map((code) => ({ code, status })),
    );
    const read = SCAN_STATUSES.some(([kind]) => unit[kind] !== null);
    const lamp =
      unit.lampOn === null || unit.codeCount === null
        ? []
        : [
            `warning lamp ${unit.lampOn ? "on" : "off"}, ${String(unit.codeCount)} stored codes reported`,
          ];
    const frozen = unit.freezeFrame;
    return {
      unit: unit.sender,
      description: `Emissions control unit ${unit.sender}`,
      requestId,
      responseId: unit.sender,
      answered: true,
      notes: [
        ...lamp,
        ...(unit.readiness === null
          ? []
          : [`monitors not complete: ${unit.readiness.incomplete.join(", ") || "none"}`]),
        ...(index === 0 ? scan.notes : []),
      ],
      identification: [
        ...(index === 0 && scan.vin !== null
          ? [{ label: "VIN", hex: toUpperHex(asciiEncode(scan.vin)), text: scan.vin }]
          : []),
        ...unit.calibrationIds.map((text) => ({
          label: "Calibration identifier",
          hex: toUpperHex(asciiEncode(text)),
          text,
        })),
      ],
      faults: read ? found : null,
      freezeFrames:
        frozen?.code == null
          ? {}
          : {
              [frozen.code]: Object.entries(frozen.values)
                .map(([name, value]) => `${name}: ${value}`)
                .join("; "),
            },
    };
  });
}

/** A decoded capture as a caller sees it: plain data that crosses the service boundary, as `captures.decode` returns it. */
export function decodedCaptureData(decoded: DecodedCapture): DecodedCaptureData {
  return {
    profile: decoded.profile,
    units: decoded.units.map(unitReportData),
    obd: decoded.obd,
    values: decoded.values.map((value) => ({ ...value })),
    discovered: decoded.discovered.map((found) => ({ ...found })),
    undecoded: decoded.undecoded.map((exchange) => exchange.seq),
    exchanges: decoded.exchanges,
    lines: decodedLines(decoded),
  };
}

/** The run as a caller sees it: its notes are what the user wrote, without the collection selection. */
function presented(run: Run): Run {
  return { ...run, notes: userNotes(run.notes) };
}

/** The status a plan command returns, or a `not-found` failure for a run no plan ran here. */
function planCommand<T>(status: T | undefined, runId: string): Promise<T> {
  if (status === undefined) {
    return Promise.reject(new StorageError("not-found", `no plan ran for run ${runId} here`));
  }
  return Promise.resolve(status);
}

/** The service's router: the contract's operations implemented over the dependencies. */
function buildRouter(dependencies: DiagnosticsDependencies) {
  const { storage, collector, link, transports, grants, loadProfile } = dependencies;
  const now = dependencies.now ?? clockNow;
  const sleep = dependencies.sleep ?? realSleep;
  const captures = new CaptureJobs({
    link,
    storage,
    toolVersion: dependencies.toolVersion,
    now,
    sleep,
    suffix: randomSuffix,
  });
  const planJobs = new PlanJobs({
    link,
    storage,
    clock: dependencies.planClock ?? systemClock,
    ...(dependencies.planCodesIntervalMs === undefined
      ? {}
      : { codesIntervalMs: dependencies.planCodesIntervalMs }),
  });
  const hub = new LiveHub();
  const confirmations = new PendingConfirmations(
    dependencies.confirmationTtlMs ?? CONFIRMATION_TTL_MS,
    now,
  );
  const sink: SampleSink = {
    write: async (samples) => {
      await storage.appendSamples(samples);
      hub.publish(samples);
    },
  };

  /** Refuses work that would start a second use of the adapter while a clear, write or actuator test waits for its answer. */
  const requirePassive = (): void => {
    if (confirmations.isPending) {
      throw new ORPCError("CONFLICT", {
        message: "an operation is waiting for its confirmation; confirm or cancel it first",
      });
    }
  };

  /** Refuses work that would share the adapter with a running recording plan. */
  const requireNoPlan = (): void => {
    if (planJobs.busy) {
      throw new ORPCError("CONFLICT", {
        message: "a recording plan holds the adapter; abort it or wait for it to end",
      });
    }
  };

  /** Refuses work on the adapter while something else holds it. */
  const requireFree = (): void => {
    requirePassive();
    requireNoPlan();
    if (collector.active().length > 0) {
      throw new ORPCError("CONFLICT", {
        message: "a collection run holds the adapter; stop it first",
      });
    }
    if (captures.busy) {
      throw new ORPCError("CONFLICT", {
        message: "a capture holds the adapter; stop it or wait for it to end",
      });
    }
  };

  /** A stored capture, or a `not-found` failure. */
  const storedCapture = async (id: string) => {
    const capture = await storage.getCapture(id);
    if (capture === undefined) throw new StorageError("not-found", `no capture ${id}`);
    return capture;
  };

  /** Runs `read` on the open connection while the adapter is free. */
  const onLink = <T>(read: (session: LinkSession) => Promise<T>): Promise<T> =>
    translated(() => {
      requireFree();
      return link.withSession(read);
    });

  const readOne = (unit: string, options: { faults: boolean; freeze: boolean }) =>
    onLink(async (session) => {
      const profile = requireProfile(session.profile, "reading one unit");
      return unitReportData(
        await readUnit(session.elm, profile, profileUnit(profile, unit), options),
      );
    });

  /** Starts a guarded command on the open connection and returns what it asks to have confirmed. */
  const request = (
    kind: GuardedKind,
    label: string,
    /** What the operation does when it addresses one unit and so needs a profile; `undefined` for one that does not. */
    needsProfile: string | undefined,
    command: (
      session: LinkSession,
      store: StorageSnapshotStore,
      save: string,
      io: Parameters<Parameters<PendingConfirmations["begin"]>[1]>[0],
    ) => Promise<number>,
  ): Promise<GuardedRequestData> =>
    translated(async () => {
      requireFree();
      const open = link.session;
      if (open === undefined) throw new NotConnected("connect an adapter first");
      if (needsProfile !== undefined) requireProfile(open.profile, needsProfile);
      const takenAt = now();
      const store = new StorageSnapshotStore(storage, {
        profile: profileLabel(open.profile),
        adapter: open.adapterUrl,
        takenAt,
      });
      const save = `${kind}-${label}-${String(takenAt)}`;
      const asked = await confirmations.begin(kind, (io) =>
        link.withSession((session) => command(session, store, save, io)),
      );
      return { ...asked, snapshot: store.saved.at(-1) ?? null };
    });

  /** The legislated scan of a generic connection, saved as a report under the generic profile name. */
  const scanGeneric = async (session: LinkSession, label: string) => {
    const bus = sessionBus(session.profile);
    const { result: obd } = await readThroughCapture(session.elm, (elm) => readObdScan(elm, bus));
    const units = obdUnitReports(obd, FUNCTIONAL_ID[bus.idBits].toString(16).toUpperCase());
    const saved = await storage.saveScanReport({
      profile: GENERIC_PROFILE,
      adapter: session.adapterUrl,
      takenAt: now(),
      label,
      report: jsonSchema.parse({
        tool: "obd-read",
        taken: isoNowSeconds(),
        profile: { name: GENERIC_PROFILE, status: "generic" },
        adapter: {
          identity: session.adapter.identity,
          description: session.adapter.description,
          stn_identity: session.adapter.stnIdentity,
          voltage: session.adapter.voltage,
        },
        units,
        obd,
        transcript: [...session.elm.transcript.entries],
      }),
    });
    return {
      report: {
        id: saved.id,
        profile: saved.profile,
        adapter: saved.adapter,
        takenAt: saved.takenAt,
        label: saved.label,
        origin: saved.origin,
      },
      units,
      obd,
    };
  };

  const os = implement(diagnosticsContract);
  return os.router({
    adapters: {
      list: os.adapters.list.handler(() => listAdapterCapabilities(transports.schemes())),
      grant: os.adapters.grant.handler(({ input }) => {
        grants.grant(input);
        return { scheme: input.scheme };
      }),
    },
    link: {
      status: os.link.status.handler(() => {
        const session = link.session;
        return session === undefined ? null : connectionData(session);
      }),
      connect: os.link.connect.handler(({ input }) =>
        translated(async () => {
          requireFree();
          return connectionData(await link.connect(input.profile, input.adapter));
        }),
      ),
      disconnect: os.link.disconnect.handler(() =>
        translated(async () => {
          requireFree();
          const was = link.session !== undefined;
          await link.disconnect();
          return { disconnected: was };
        }),
      ),
      probe: os.link.probe.handler(() =>
        onLink(async (session) => {
          const profile = requireProfile(session.profile, "probing the units of a profile");
          return {
            adapter: { ...session.adapter },
            units: (await scan(session.elm, profile, { faults: false, freeze: false })).map(
              unitReportData,
            ),
          };
        }),
      ),
    },
    units: {
      ident: os.units.ident.handler(({ input }) =>
        readOne(input.unit, { faults: false, freeze: false }),
      ),
      faults: os.units.faults.handler(({ input }) =>
        readOne(input.unit, { faults: true, freeze: false }),
      ),
      freeze: os.units.freeze.handler(({ input }) =>
        readOne(input.unit, { faults: true, freeze: true }),
      ),
    },
    scan: {
      run: os.scan.run.handler(({ input }) =>
        onLink(async (session) => {
          if (session.profile === undefined) {
            return scanGeneric(session, input.label);
          }
          const profile = session.profile;
          const { result: reports } = await readThroughCapture(session.elm, (elm) =>
            scan(elm, profile, { faults: true, freeze: input.freeze }),
          );
          const document = scanDocument(
            session.profile,
            session.adapter,
            reports,
            session.elm.transcript.entries,
          );
          const saved = await storage.saveScanReport({
            profile: session.profile.name,
            adapter: session.adapterUrl,
            takenAt: now(),
            label: input.label,
            report: jsonSchema.parse(JSON.parse(jsonText(document.json))),
          });
          return {
            report: {
              id: saved.id,
              profile: saved.profile,
              adapter: saved.adapter,
              takenAt: saved.takenAt,
              label: saved.label,
              origin: saved.origin,
            },
            units: reports.map(unitReportData),
            obd: null,
          };
        }),
      ),
    },
    reports: {
      list: os.reports.list.handler(({ input }) =>
        translated(() => storage.listScanReports(input)),
      ),
      get: os.reports.get.handler(({ input }) =>
        translated(async () => {
          const report = await storage.getScanReport(input.id);
          if (report === undefined) throw new StorageError("not-found", `no report ${input.id}`);
          return report;
        }),
      ),
    },
    battery: {
      voltage: os.battery.voltage.handler(() =>
        onLink(async (session) => ({
          volts: await readVoltage(session.elm, { stn: session.adapter.hasStnExtensions }),
        })),
      ),
    },
    monitor: {
      capture: os.monitor.capture.handler(({ input }) =>
        translated(() => {
          requireFree();
          return link.exclusive(async () => {
            if (link.session !== undefined) {
              throw new LinkBusy(
                "disconnect before monitoring: the monitor opens the adapter itself",
              );
            }
            const lines: string[] = [];
            await runMonitor(
              {
                adapter: input.adapter,
                idBits: input.idBits,
                bitrate: input.bitrate,
                durationMs: input.durationMs,
                ...(input.count === undefined ? {} : { count: input.count }),
              },
              (line) => lines.push(line),
              (url) => transports.create(url),
            );
            return { lines };
          });
        }),
      ),
    },
    clear: {
      request: os.clear.request.handler(({ input }) =>
        request(
          "clear",
          input.target.kind === "obd" ? "obd" : input.target.unit,
          input.target.kind === "obd" ? undefined : "clearing one unit's fault codes",
          (session, store, save, io) => {
            if (input.target.kind === "obd") {
              const bus = sessionBus(session.profile);
              return clearCodesCommand({
                elm: session.elm,
                adapter: session.adapter,
                store,
                idBits: bus.idBits,
                bitrate: bus.bitrate,
                save,
                yes: false,
                ...io,
              });
            }
            return profileCommand(
              { command: "clear", unit: input.target.unit, save, yes: false },
              {
                elm: session.elm,
                adapter: session.adapter,
                profile: requireProfile(session.profile, "clearing one unit's fault codes"),
                store,
                ...io,
              },
            );
          },
        ),
      ),
      confirm: os.clear.confirm.handler(({ input }) =>
        translated(() => confirmations.confirm(input.confirmation, "clear")),
      ),
    },
    write: {
      request: os.write.request.handler(({ input }) =>
        request("write", input.unit, "writing a value", (session, store, save, io) =>
          profileCommand(
            {
              command: "write",
              unit: input.unit,
              save,
              request: requestBytes(input.request),
              read: requestBytes(input.read),
            },
            {
              elm: session.elm,
              adapter: session.adapter,
              profile: requireProfile(session.profile, "writing a value"),
              store,
              ...io,
            },
          ),
        ),
      ),
      confirm: os.write.confirm.handler(({ input }) =>
        translated(() => confirmations.confirm(input.confirmation, "write")),
      ),
    },
    actuate: {
      request: os.actuate.request.handler(({ input }) =>
        request("actuate", input.unit, "an actuator test", (session, store, save, io) =>
          profileCommand(
            {
              command: "actuate",
              unit: input.unit,
              request: requestBytes(input.request),
              stop: requestBytes(input.stop),
              durationMs: input.durationMs,
              sleep,
            },
            {
              elm: session.elm,
              adapter: session.adapter,
              profile: requireProfile(session.profile, "an actuator test"),
              store,
              ...io,
            },
          ),
        ),
      ),
      confirm: os.actuate.confirm.handler(({ input }) =>
        translated(() => confirmations.confirm(input.confirmation, "actuate")),
      ),
    },
    guarded: {
      cancel: os.guarded.cancel.handler(({ input }) =>
        translated(() => confirmations.cancel(input.confirmation)),
      ),
    },
    runs: {
      start: os.runs.start.handler(({ input }) =>
        translated(async () => {
          requirePassive();
          requireNoPlan();
          if (input.profile === undefined && input.unit !== undefined) {
            throw new ProfileRequired("collecting one unit's values");
          }
          const selection = {
            ...(input.unit === undefined ? {} : { unit: input.unit }),
            ...(input.signals === undefined ? {} : { signals: input.signals }),
          };
          const run = await storage.createRun({
            profile: input.profile ?? GENERIC_PROFILE,
            adapter: input.adapter,
            startedAt: now(),
            notes: withSelection(input.notes ?? "", selection),
          });
          try {
            await collector.start(run, selection, sink);
          } catch (error) {
            await storage.deleteRun(run.id);
            throw (
              callerError(error) ??
              new ORPCError("INTERNAL_SERVER_ERROR", {
                message: `could not start collecting: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              })
            );
          }
          return presented(run);
        }),
      ),
      resume: os.runs.resume.handler(({ input }) =>
        translated(async () => {
          requirePassive();
          requireNoPlan();
          const run = await storage.getRun(input.runId);
          if (run === undefined) throw new StorageError("not-found", `no run ${input.runId}`);
          const plan = recordedPlan(run.notes);
          if (plan !== undefined) {
            throw new StorageError(
              "conflict",
              `run ${run.id} was recorded by the plan ${plan}, and a plan does not resume`,
            );
          }
          if (!allowsWrites(run.origin)) {
            throw new StorageError(
              "conflict",
              `run ${run.id} is ${run.origin} data, not read here, and cannot be collected into`,
            );
          }
          if (run.stoppedAt !== null) {
            throw new StorageError("conflict", `run ${run.id} is stopped and cannot be resumed`);
          }
          await collector.start(run, readSelection(run.notes), sink);
          return presented(run);
        }),
      ),
      stop: os.runs.stop.handler(({ input }) =>
        translated(async () => {
          await collector.stop(input.runId);
          return presented(await storage.stopRun(input.runId, now()));
        }),
      ),
      status: os.runs.status.handler(({ input }) => collector.status(input.runId) ?? null),
      list: os.runs.list.handler(({ input }) =>
        translated(async () => (await storage.listRuns(input)).map(presented)),
      ),
      get: os.runs.get.handler(({ input }) =>
        translated(async () => {
          const run = await storage.getRun(input.runId);
          if (run === undefined) throw new StorageError("not-found", `no run ${input.runId}`);
          return presented(run);
        }),
      ),
      samples: os.runs.samples.handler(({ input }) => translated(() => storage.readSamples(input))),
      aggregate: os.runs.aggregate.handler(({ input }) =>
        translated(() => storage.aggregate(input)),
      ),
      export: os.runs.export.handler(({ input }) =>
        translated(async () => {
          const base = `obd-read-run-${input.runId}`;
          const { extension, mediaType } = FORMAT_FILES[input.format];
          if (input.format !== "json") {
            return {
              filename: `${base}.${extension}`,
              mediaType,
              content: await exportRunDelimitedText(storage, input.runId, input.format),
            };
          }
          const exported = await exportRunJson(storage, input.runId);
          return {
            filename: `${base}.${extension}`,
            mediaType,
            content: JSON.stringify({ ...exported, run: presented(exported.run) }),
          };
        }),
      ),
      import: os.runs.import.handler(({ input }) =>
        translated(async () =>
          presented(
            await importRunTable(storage, input.text, {
              profile: IMPORTED_RUN_PROFILE,
              adapter: `file ${input.name}`,
              notes: "",
            }),
          ),
        ),
      ),
    },
    live: {
      samples: os.live.samples.handler(({ input, signal }) => hub.subscribe(input.runId, signal)),
    },
    captures: {
      start: os.captures.start.handler(({ input }) =>
        translated(() => {
          requireFree();
          if (link.session === undefined) throw new NotConnected("connect an adapter first");
          return Promise.resolve(captures.start(input));
        }),
      ),
      stop: os.captures.stop.handler(({ input }) =>
        translated(() => {
          const status = captures.stop(input.id);
          if (status === undefined)
            throw new StorageError("not-found", `no capture ${input.id} is running here`);
          return Promise.resolve(status);
        }),
      ),
      status: os.captures.status.handler(({ input }) => captures.status(input.id) ?? null),
      progress: os.captures.progress.handler(({ input, signal }) =>
        captures.progress(input.id, signal),
      ),
      list: os.captures.list.handler(({ input }) => translated(() => storage.listCaptures(input))),
      get: os.captures.get.handler(({ input }) => translated(() => storedCapture(input.id))),
      delete: os.captures.delete.handler(({ input }) =>
        translated(async () => {
          const existed = (await storage.getCapture(input.id)) !== undefined;
          await storage.deleteCapture(input.id);
          return { deleted: existed };
        }),
      ),
      import: os.captures.import.handler(({ input }) =>
        translated(async () => {
          const at = now();
          const { capture, unrecovered } = importRecord(
            input.text,
            `import-${new Date(at).toISOString().replace(/[-:.]/g, "")}-${randomSuffix()}`,
            input.name,
          );
          return {
            summary: await storage.saveCapture(capture, "imported"),
            unrecovered: [...unrecovered],
          };
        }),
      ),
      decode: os.captures.decode.handler(({ input }) =>
        translated(async () => {
          const capture = await storedCapture(input.id);
          const target: DecodeTarget =
            input.profile === null
              ? { kind: "generic" }
              : { kind: "profile", profile: await loadProfile(input.profile) };
          const decoded =
            input.exchanges === undefined
              ? await decodeCapture(capture, target)
              : await decodeAsOf(capture, target, input.exchanges);
          return decodedCaptureData(decoded);
        }),
      ),
    },
    plans: {
      list: os.plans.list.handler(() =>
        [...dependencies.plans.names()].sort().map((name) => dependencies.plans.load(name)),
      ),
      start: os.plans.start.handler(({ input }) =>
        translated(async () => {
          const plan =
            input.plan.kind === "shipped"
              ? dependencies.plans.load(input.plan.name)
              : parsePlanText(input.plan.text, input.plan.name);
          requireFree();
          const session = link.session;
          if (session === undefined) throw new NotConnected("connect an adapter first");
          const bus = sessionBus(session.profile);
          return planJobs.start(plan, {
            adapter: session.adapterUrl,
            ...(session.profile === undefined ? {} : { profile: session.profile.name }),
            idBits: bus.idBits,
            bitrate: bus.bitrate,
            notes: withPlan(planRunNotes(plan), plan.name),
          });
        }),
      ),
      status: os.plans.status.handler(({ input }) => planJobs.status(input.runId) ?? null),
      events: os.plans.events.handler(({ input, signal }) => planJobs.events(input.runId, signal)),
      confirm: os.plans.confirm.handler(({ input }) =>
        translated(() => planCommand(planJobs.confirm(input.runId), input.runId)),
      ),
      skip: os.plans.skip.handler(({ input }) =>
        translated(() => planCommand(planJobs.skipPhase(input.runId), input.runId)),
      ),
      abort: os.plans.abort.handler(({ input }) =>
        translated(() => planCommand(planJobs.abort(input.runId), input.runId)),
      ),
      recover: os.plans.recover.handler(({ input }) =>
        translated(async () => {
          const stopped: Run[] = [];
          for (const runId of input.runIds) {
            const run = await storage.getRun(runId);
            if (
              // An unknown run has no `stoppedAt` and is skipped with the stopped ones.
              run?.stoppedAt !== null ||
              recordedPlan(run.notes) === undefined ||
              planJobs.isRunning(run.id)
            ) {
              continue;
            }
            // Stopped at its last reading, not now, so the run does not span the time the page was away.
            const last = Math.max(
              run.startedAt,
              ...(await storage.aggregate({ runId: run.id })).map((signal) => signal.lastAt),
            );
            stopped.push(presented(await storage.stopRun(run.id, last)));
          }
          return stopped;
        }),
      ),
    },
    profiles: {
      import: os.profiles.import.handler(({ input }) =>
        translated(async () => {
          const document = parseJson(input.json, "imported profile");
          const problems = checkProfile(document, "imported profile");
          if (problems.length > 0) throw new ProfileError(problems);
          const profile = parseProfile(document, "imported profile");
          if (profile.name === GENERIC_PROFILE) {
            throw new ProfileError([
              `the name ${GENERIC_PROFILE} is reserved for connections with no profile`,
            ]);
          }
          const { replaced } = await storage.saveProfile({
            name: profile.name,
            importedAt: now(),
            document: jsonSchema.parse(document),
          });
          return { name: profile.name, description: profile.description, replaced };
        }),
      ),
      list: os.profiles.list.handler(() =>
        translated(async () => (await storage.listProfiles()).map((profile) => profile.name)),
      ),
    },
  });
}

/** The implemented service, ready to be called in process or served over a link. */
export interface DiagnosticsHost {
  /** The router to serve with an oRPC handler (message port, WebSocket, ...). */
  readonly router: ReturnType<typeof buildRouter>;
  /** A client that calls the router directly, in this process. */
  readonly client: RouterClient<ReturnType<typeof buildRouter>>;
}

/** The type of the client {@link DiagnosticsHost.client} and the worker link produce. */
export type DiagnosticsClient = RouterClient<ReturnType<typeof buildRouter>>;

/**
 * Builds the diagnostics service over `dependencies`.
 *
 * Handlers translate the failures a caller can act on into oRPC errors: `NOT_FOUND`, `CONFLICT` and `BAD_REQUEST` for storage and profile problems, `FORBIDDEN` for a request the guard refuses, `PRECONDITION_FAILED` for an operation that needs a connection, `BAD_GATEWAY` for an adapter or unit that failed. Anything else surfaces as an internal error.
 */
export function createDiagnosticsHost(dependencies: DiagnosticsDependencies): DiagnosticsHost {
  const router = buildRouter(dependencies);
  return { router, client: createRouterClient(router) };
}

export type { DiagnosticsContract };
