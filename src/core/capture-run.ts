/**
 * The capture operation: read everything a car offers through the guard's read-only allowlists and keep every raw exchange, whatever profile the session has.
 *
 * {@link captureEverything} runs these steps, recording every request and reply:
 *
 * 1. The legislated OBD-II reads, for everything the car's supported-identifier bitmaps list.
 * 2. With a profile, the identification, fault-code and freeze-frame reads of every unit of the profile (units reached with an extended address included). With none, a bounded discovery sweep of request identifiers with each protocol's default-session request, then the same reads of every unit that answered.
 * 3. Only when asked, a rate-limited, budgeted sweep of read-only data identifiers (UDS `22`, KWP2000 `21`) on every unit that answered.
 *
 * Every request goes through `permit` with no token, so only the read-only services pass: nothing is written, actuated, cleared, and no security access is opened. A stop request ends the capture after the request in flight, and the capture says it is incomplete. This module is platform-free.
 */

import { z } from "zod";
import { hexNumber } from "./bytes.js";
import {
  CaptureRecorder,
  TOOL_NAME,
  buildCapture,
  captureAdapter,
  type Capture,
  type CaptureOrigin,
} from "./capture.js";
import { DEFAULT_SESSION, MAX_ID, sweep, type Found } from "./discovery.js";
import { ElmError, type AdapterInfo, type Elm } from "./elm.js";
import { GENERIC_BUS } from "./generic.js";
import { DiagProtocol, READ_SERVICE, permit } from "./guard.js";
import { selectBus } from "./kline.js";
import { readAddressedObdScan } from "./obd-scan.js";
import { readUnit, scan, type UnitReport } from "./operations.js";
import { FUNCTIONAL_ID } from "./obd.js";
import { NegativeResponse } from "./diag.js";
import {
  MAX_IDENTIFIER,
  parseProfile,
  type Profile,
  type ProfileProtocol,
  type Unit,
} from "./profile.js";
import { sleep as defaultSleep } from "./time.js";
import { TransportError } from "./transport.js";

/** The most requests one identifier sweep may send. */
export const MAX_SWEEP_BUDGET = 20_000;

/** The shortest pause between two requests of an identifier sweep, in milliseconds. */
export const MIN_SWEEP_PAUSE_MS = 10;

/** The pause between two requests of an identifier sweep unless one is given, in milliseconds. */
export const DEFAULT_SWEEP_PAUSE_MS = 50;

/** The request budget of an identifier sweep unless one is given. */
export const DEFAULT_SWEEP_BUDGET = 2000;

/**
 * An identifier sweep: the identifiers from `first` to `last` inclusive, read on every unit that answered, at most `budget` requests in all with `pauseMs` between two of them. The read service is the protocol's read-data service; nothing else can be swept.
 */
export const identifierSweepSchema = z
  .strictObject({
    first: z.int().min(0).max(0xffff),
    last: z.int().min(0).max(0xffff),
    budget: z.int().min(1).max(MAX_SWEEP_BUDGET),
    pauseMs: z.int().min(MIN_SWEEP_PAUSE_MS).max(60_000),
  })
  .refine((range) => range.first <= range.last, { error: "first must not be after last" });

/** An identifier sweep. */
export type IdentifierSweep = z.output<typeof identifierSweepSchema>;

/** The request identifiers a capture with no profile tries, and with which protocols' default sessions. */
export const discoveryRangeSchema = z
  .strictObject({
    first: z.int().min(0).max(MAX_ID),
    last: z.int().min(0).max(MAX_ID),
    protocols: z
      .array(z.enum([DiagProtocol.KWP2000, DiagProtocol.UDS]))
      .min(1)
      .max(2),
  })
  .refine((range) => range.first <= range.last, { error: "first must not be after last" });

/** The discovery sweep of a capture with no profile. */
export type DiscoveryRange = z.output<typeof discoveryRangeSchema>;

/** The discovery sweep a capture with no profile runs unless told otherwise: the range the `discover` command tries, with both protocols. */
export const DEFAULT_DISCOVERY: DiscoveryRange = {
  first: 0x700,
  last: MAX_ID,
  protocols: [DiagProtocol.UDS, DiagProtocol.KWP2000],
};

/** The step a capture is on. */
export type CaptureStep = "legislated" | "units" | "discovery" | "identifiers";

/** How far a capture has got. */
export interface CaptureProgress {
  readonly step: CaptureStep;
  /** Requests recorded so far. */
  readonly exchanges: number;
  /** One line saying what is being read. */
  readonly detail: string;
}

/** What {@link captureEverything} needs. */
export interface CaptureRunOptions {
  /** The profile to read units with, or `undefined` to discover them. */
  readonly profile: Profile | undefined;
  /** The discovery sweep with no profile; defaults to {@link DEFAULT_DISCOVERY}. Ignored with a profile. */
  readonly discovery?: DiscoveryRange;
  /** The identifier sweep; absent, none is run. */
  readonly identifiers?: IdentifierSweep;
  /** The adapter as the session reported it, and the URL it was opened with. */
  readonly adapter: AdapterInfo;
  readonly adapterUrl: string | null;
  /** The version of the program, as the capture records it. */
  readonly toolVersion: string;
  /** The capture's identifier. */
  readonly id: string;
  /** Told after each step and every few requests. */
  readonly progress?: (progress: CaptureProgress) => void;
  /** Asked before every request of a sweep and between steps; `true` stops the capture. */
  readonly stopped?: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The capture was stopped before it finished. */
class Stopped extends Error {
  override name = "Stopped";
}

/** A profile naming the units a discovery sweep found, so the unit reads can address them. */
function discoveredProfile(protocol: ProfileProtocol, found: readonly Found[]): Profile {
  const units: Record<string, unknown> = {};
  for (const unit of found) {
    units[`unit-${hexNumber(unit.requestId, 3).toLowerCase()}`] = {
      description: `answered the ${protocol} default session on ${hexNumber(unit.requestId, 3)}`,
      request: unit.requestId,
      response: unit.responseId,
      source: "discovery sweep during capture",
    };
  }
  return parseProfile(
    {
      name: `discovered-${protocol}`,
      description: "Units a capture's discovery sweep found",
      status: "unconfirmed",
      bus: { id_bits: GENERIC_BUS.idBits, bitrate: GENERIC_BUS.bitrate },
      diagnostics: { protocol, session: DEFAULT_SESSION[protocol] },
      units,
    },
    "discovered units",
  );
}

/** The request that reads one identifier with the protocol's read-data service. */
function identifierRequest(protocol: ProfileProtocol, identifier: number): Uint8Array {
  const service = READ_SERVICE.get(protocol);
  if (service === undefined) throw new RangeError(`no read service for ${protocol}`);
  return protocol === DiagProtocol.UDS
    ? Uint8Array.of(service, identifier >> 8, identifier & 0xff)
    : Uint8Array.of(service, identifier);
}

/** Whether a failure is one the car or the adapter reported, which a capture records and goes past. */
function recordable(error: unknown): boolean {
  return (
    error instanceof ElmError ||
    error instanceof NegativeResponse ||
    error instanceof TransportError
  );
}

/**
 * Reads everything the car offers through the read-only allowlists and returns every exchange as a capture.
 *
 * The session must be initialised and have no bus selected yet, or the profile's. A failure the car or the adapter reports in one step is recorded in the capture's notes and the next step runs; a stop ends the capture with `complete: false`.
 *
 * @throws GuardError when a request the steps build is refused, which means a profile names a session the guard does not allow.
 */
export async function captureEverything(elm: Elm, options: CaptureRunOptions): Promise<Capture> {
  const now = options.now ?? (() => Date.now());
  const pause = options.sleep ?? defaultSleep;
  const startedAt = now();
  const recorder = new CaptureRecorder(elm, { now });
  const notes: string[] = [];
  const { profile } = options;
  const tell = (step: CaptureStep, detail: string): void => {
    options.progress?.({ step, exchanges: recorder.exchanges.length, detail });
  };
  const check = (): void => {
    if (options.stopped?.() === true) throw new Stopped("stopped");
  };

  let complete = true;
  recorder.start();
  try {
    check();
    tell("legislated", "reading the legislated OBD-II services");
    try {
      if (profile?.bus.kind === "kline") {
        await selectBus(elm, profile);
        await elm.addressFunctional(FUNCTIONAL_ID[11]);
      } else {
        const bus = profile === undefined ? GENERIC_BUS : profile.bus;
        await elm.selectCan(bus.idBits, bus.bitrate);
        await elm.addressFunctional(FUNCTIONAL_ID[bus.idBits]);
      }
      await readAddressedObdScan(elm);
    } catch (error) {
      if (!recordable(error)) throw error;
      notes.push(
        `legislated reads stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Each unit carries its own protocol, session and identifier width, which the sweep reads it with.
    const answered: Unit[] = [];
    const keep = (reading: Profile, reports: readonly UnitReport[]): void => {
      for (const report of reports) {
        const unit = reading.units.get(report.unit);
        if (report.answered && unit !== undefined) answered.push(unit);
      }
    };

    check();
    if (profile !== undefined) {
      tell("units", `reading the ${String(profile.units.size)} units of ${profile.name}`);
      await selectBus(elm, profile);
      keep(profile, await scan(elm, profile, { faults: true, freeze: true }));
    } else {
      const range = options.discovery ?? DEFAULT_DISCOVERY;
      await elm.selectCan(GENERIC_BUS.idBits, GENERIC_BUS.bitrate);
      for (const protocol of range.protocols) {
        check();
        tell(
          "discovery",
          `trying ${hexNumber(range.first, 3)} to ${hexNumber(range.last, 3)} with the ${protocol} default session`,
        );
        const result = await sweep(
          elm,
          protocol,
          DEFAULT_SESSION[protocol],
          range.first,
          range.last,
          check,
        );
        for (const [requestId, message] of result.errors) {
          notes.push(`discovery ${protocol} ${hexNumber(requestId, 3)}: ${message}`);
        }
        const accepted = result.found.filter((found) => found.accepted);
        const unique = accepted.filter(
          (found, index) =>
            accepted.findIndex((other) => other.requestId === found.requestId) === index,
        );
        if (unique.length === 0) continue;
        const reading = discoveredProfile(protocol, unique);
        tell("units", `reading the ${String(unique.length)} units that answered ${protocol}`);
        const reports: UnitReport[] = [];
        for (const unit of reading.units.values()) {
          check();
          reports.push(await readUnit(elm, reading, unit, { faults: true, freeze: true }));
        }
        keep(reading, reports);
      }
    }

    const identifiers = options.identifiers;
    if (identifiers !== undefined) {
      let budget = identifiers.budget;
      for (const unit of answered) {
        const last = Math.min(identifiers.last, MAX_IDENTIFIER[unit.protocol]);
        if (identifiers.first > last) continue;
        check();
        tell(
          "identifiers",
          `reading identifiers ${hexNumber(identifiers.first, 2)} to ${hexNumber(last, 2)} of ${unit.name}`,
        );
        await elm.addressUnit(unit.requestId, unit.responseId, unit.extendedAddress, unit.idBits);
        try {
          await elm.request(await permit(unit.protocol, Uint8Array.of(0x10, unit.session)));
        } catch (error) {
          if (!recordable(error)) throw error;
        }
        for (let identifier = identifiers.first; identifier <= last; identifier++) {
          if (budget === 0) {
            notes.push(
              `identifier sweep stopped at its budget of ${String(identifiers.budget)} requests`,
            );
            break;
          }
          check();
          await pause(identifiers.pauseMs);
          budget -= 1;
          try {
            await elm.request(
              await permit(unit.protocol, identifierRequest(unit.protocol, identifier)),
            );
          } catch (error) {
            if (!recordable(error)) throw error;
          }
          if (recorder.exchanges.length % 25 === 0) {
            tell("identifiers", `${unit.name}: identifier ${hexNumber(identifier, 2)}`);
          }
        }
        if (budget === 0) break;
      }
    }
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    complete = false;
    notes.push("stopped before it finished");
  } finally {
    recorder.stop();
  }
  if (recorder.full)
    notes.push("the capture reached its size limit; later exchanges were not kept");

  const origin: CaptureOrigin = {
    kind: "capture",
    profile: profile?.name ?? null,
    complete,
    description: [
      "legislated reads",
      profile === undefined ? "discovery sweep and unit reads" : `unit reads of ${profile.name}`,
      ...(options.identifiers === undefined
        ? []
        : [
            `identifier sweep ${hexNumber(options.identifiers.first, 2)} to ${hexNumber(options.identifiers.last, 2)}`,
          ]),
    ].join(", "),
  };
  return buildCapture(
    {
      id: options.id,
      startedAt,
      endedAt: Math.max(startedAt, now()),
      origin,
      session: {
        adapter: captureAdapter(options.adapter, options.adapterUrl),
        tool: { name: TOOL_NAME, version: options.toolVersion },
      },
      notes,
    },
    recorder.exchanges,
  );
}
