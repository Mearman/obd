/**
 * The usual composition of a diagnostics service: a link, a collector over it and the host.
 *
 * An edge supplies storage, a transport host and a profile loader; this wires the rest. It exists so the worker, the Node daemon and the tests do not each assemble the same four objects.
 */

import { LiveCollector, type CollectorTiming } from "./collector.js";
import { DeviceLink } from "./device-link.js";
import { parseProfile, type Profile } from "./profile.js";
import type { PlanClock } from "./plan-runner.js";
import { createDiagnosticsHost, type DiagnosticsHost, type PlanCatalogue } from "./service-impl.js";
import type { Storage } from "./storage.js";
import { DeviceGrants, type TransportHost } from "./transport-host.js";

/** Finds a profile by name, preferring one the user imported over a shipped one of the same name. */
export function profileLoader(
  storage: Storage,
  shipped: (name: string) => unknown,
): (name: string) => Promise<Profile> {
  return async (name) => {
    const imported = await storage.getProfile(name);
    return parseProfile(imported === undefined ? shipped(name) : imported.document, name);
  };
}

/** What {@link createDiagnosticsService} takes from its edge. */
export interface DiagnosticsServiceOptions {
  readonly storage: Storage;
  readonly transports: TransportHost;
  /** Finds a profile by name; see {@link profileLoader}. */
  readonly loadProfile: (name: string) => Promise<Profile>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timing?: CollectorTiming;
  readonly confirmationTtlMs?: number;
  /** The devices a page granted; defaults to an empty set the service's `adapters.grant` fills. */
  readonly grants?: DeviceGrants;
  /** The program's version, as captures record it. */
  readonly toolVersion: string;
  /** The shipped recording plans. */
  readonly plans: PlanCatalogue;
  /** Time and waiting for recording plans; defaults to the real clock. */
  readonly planClock?: PlanClock;
  /** The gap between reads of the fault code lists while a plan's phase watches them. */
  readonly planCodesIntervalMs?: number;
}

/** A composed service with the parts an edge needs to reach. */
export interface DiagnosticsService {
  readonly host: DiagnosticsHost;
  readonly link: DeviceLink;
  readonly grants: DeviceGrants;
}

/** Builds the link, the collector and the host over the edge's storage and transports. */
export function createDiagnosticsService(options: DiagnosticsServiceOptions): DiagnosticsService {
  const link = new DeviceLink({ transports: options.transports, loadProfile: options.loadProfile });
  const grants = options.grants ?? new DeviceGrants();
  const collector = new LiveCollector({
    link,
    ...options.timing,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const host = createDiagnosticsHost({
    storage: options.storage,
    collector,
    link,
    transports: options.transports,
    grants,
    loadProfile: options.loadProfile,
    toolVersion: options.toolVersion,
    plans: options.plans,
    ...(options.planClock === undefined ? {} : { planClock: options.planClock }),
    ...(options.planCodesIntervalMs === undefined
      ? {}
      : { planCodesIntervalMs: options.planCodesIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.confirmationTtlMs === undefined
      ? {}
      : { confirmationTtlMs: options.confirmationTtlMs }),
  });
  return { host, link, grants };
}
