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
  type GuardedRequestData,
  type UnitReportData,
} from "./service.js";
import { ActuationError } from "./actuate.js";
import { asciiEncode, toUpperHex } from "./bytes.js";
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
import { ProfileError, parseJson, parseProfile, profileUnit } from "./profile.js";
import { checkProfile } from "./profile-check.js";
import { exportRunCsvText, exportRunJson } from "./run-export.js";
import { readSelection, userNotes, withSelection } from "./run-selection.js";
import { isSimulatorUrl } from "./simulator-host.js";
import { StorageSnapshotStore } from "./snapshot-store.js";
import { isoNowSeconds, now as clockNow, sleep as realSleep } from "./time.js";
import { StorageError, jsonSchema, type Run, type Sample, type Storage } from "./storage.js";
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
    error instanceof AdapterUrlError
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof GuardError) return new ORPCError("FORBIDDEN", { message: error.message });
  if (
    error instanceof ClearRefused ||
    error instanceof WriteRefused ||
    error instanceof LinkBusy ||
    error instanceof ConfirmationPending
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

/** The run as a caller sees it: its notes are what the user wrote, without the collection selection. */
function presented(run: Run): Run {
  return { ...run, notes: userNotes(run.notes) };
}

/** The service's router: the contract's operations implemented over the dependencies. */
function buildRouter(dependencies: DiagnosticsDependencies) {
  const { storage, collector, link, transports, grants } = dependencies;
  const now = dependencies.now ?? clockNow;
  const sleep = dependencies.sleep ?? realSleep;
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

  /** Refuses work on the adapter while something else holds it. */
  const requireFree = (): void => {
    requirePassive();
    if (collector.active().length > 0) {
      throw new ORPCError("CONFLICT", {
        message: "a collection run holds the adapter; stop it first",
      });
    }
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
    const obd = await readObdScan(session.elm, bus);
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
          const reports = await scan(session.elm, session.profile, {
            faults: true,
            freeze: input.freeze,
          });
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
          const run = await storage.getRun(input.runId);
          if (run === undefined) throw new StorageError("not-found", `no run ${input.runId}`);
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
          if (input.format === "csv") {
            return {
              filename: `${base}.csv`,
              mediaType: "text/csv",
              content: await exportRunCsvText(storage, input.runId),
            };
          }
          const exported = await exportRunJson(storage, input.runId);
          return {
            filename: `${base}.json`,
            mediaType: "application/json",
            content: JSON.stringify({ ...exported, run: presented(exported.run) }),
          };
        }),
      ),
    },
    live: {
      samples: os.live.samples.handler(({ input, signal }) => hub.subscribe(input.runId, signal)),
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
