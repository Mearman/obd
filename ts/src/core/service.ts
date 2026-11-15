/**
 * The `DiagnosticsService` contract: what a UI (a page, a CLI, a phone) may ask of the machine that holds the adapter and the storage.
 *
 * The contract is written once with oRPC (`@orpc/contract`, Zod schemas as Standard Schema) and implemented at the edge: in process (`service-impl.ts`), in a dedicated worker over a message port, or in a Node daemon over a socket. The guard runs on the implementation side, so no client can bypass it. Transports, ELM and the protocol layers stay plain async interfaces below this line.
 *
 * Two contracts live here. {@link diagnosticsContract} holds the operations that are implemented. {@link pendingDiagnosticsContract} declares the operations that need the OBD, live and scan modules, which this package does not yet wire to the service; it is not part of the served contract, so a client cannot call what no implementation backs. A procedure moves into `diagnosticsContract` in the same change that implements it.
 *
 * Usage and times follow {@link Storage}: times are integer milliseconds since the Unix epoch.
 */

import { asyncIteratorObject, oc } from "@orpc/contract";
import { z } from "zod";
import { SCHEMES } from "./transport.js";
import {
  aggregateQuerySchema,
  jsonSchema,
  runQuerySchema,
  runSchema,
  sampleQuerySchema,
  sampleSchema,
  signalAggregateSchema,
} from "./storage.js";

const nameSchema = z.string().min(1);

/** What one adapter scheme can do on the machine hosting the service. */
export const adapterCapabilitySchema = z.object({
  scheme: z.enum(SCHEMES),
  /** Which entry point builds transports for the scheme. */
  platform: z.enum(["node", "browser"]),
  /** Whether this host has a transport registered for the scheme. */
  available: z.boolean(),
  /** Whether the user picks the device in a prompt a gesture opens, so the URL's target is only a label. */
  userPicksDevice: z.boolean(),
  /** One line saying what the scheme reaches. */
  description: z.string(),
});

/** What one adapter scheme can do on the host. */
export type AdapterCapability = z.output<typeof adapterCapabilitySchema>;

/** What a caller gives to start a collection run. */
export const startRunInputSchema = z.object({
  /** The profile to collect for: a shipped profile or one imported earlier. */
  profile: nameSchema,
  /** The adapter URL, such as `ble://vLinker`. */
  adapter: nameSchema,
  notes: z.string().optional(),
  /** The profile values to poll, by name; omitted means every value the profile names. */
  signals: z.array(nameSchema).min(1).optional(),
});

/** What a caller gives to start a collection run. */
export type StartRunInput = z.output<typeof startRunInputSchema>;

/** The file formats a run can be exported in. */
export const EXPORT_FORMATS = ["csv", "json"] as const;

/** A run exported as a file the caller saves. */
export const exportedRunSchema = z.object({
  /** A name for the file, with its extension. */
  filename: nameSchema,
  mediaType: nameSchema,
  /** The file's text. */
  content: z.string(),
});

/** A run exported as a file. */
export type ExportedRun = z.output<typeof exportedRunSchema>;

/** What a caller gives to import a profile: the profile file's JSON text. */
export const importProfileInputSchema = z.object({ json: z.string() });

/** The outcome of importing a profile. */
export const importedProfileSchema = z.object({
  name: nameSchema,
  description: z.string(),
  /** Whether it replaced an imported profile of the same name. */
  replaced: z.boolean(),
});

/** The outcome of importing a profile. */
export type ImportedProfile = z.output<typeof importedProfileSchema>;

/** The live samples a caller wants: those of one run, or of every run being collected. */
export const liveSamplesInputSchema = z.object({ runId: nameSchema.optional() });

const runIdInput = z.object({ runId: nameSchema });

/** The operations that are implemented. */
export const diagnosticsContract = {
  adapters: {
    /** Every adapter scheme with whether this host serves it. */
    list: oc.output(z.array(adapterCapabilitySchema)),
  },
  runs: {
    /** Opens a run and starts collecting; the run is returned open. */
    start: oc.input(startRunInputSchema).output(runSchema),
    /** Stops collecting for a run and closes it. */
    stop: oc.input(runIdInput).output(runSchema),
    /** Stored runs, newest first. */
    list: oc.input(runQuerySchema).output(z.array(runSchema)),
    /** One stored run; rejects with `NOT_FOUND` when there is none. */
    get: oc.input(runIdInput).output(runSchema),
    /** A run's samples in time order. */
    samples: oc.input(sampleQuerySchema).output(z.array(sampleSchema)),
    /** Per-signal summaries of a run's samples. */
    aggregate: oc.input(aggregateQuerySchema).output(z.array(signalAggregateSchema)),
    /** A run as CSV or JSON text for the caller to save. */
    export: oc
      .input(z.object({ runId: nameSchema, format: z.enum(EXPORT_FORMATS) }))
      .output(exportedRunSchema),
  },
  live: {
    /**
     * Samples as they are collected, from the moment of the call until the caller stops iterating. Samples already stored are not replayed: read them with `runs.samples`. A subscriber that falls too far behind is ended with an error rather than silently losing samples.
     */
    samples: oc.input(liveSamplesInputSchema).output(asyncIteratorObject(sampleSchema)),
  },
  profiles: {
    /** Validates a profile file and keeps it, replacing an imported profile of the same name. */
    import: oc.input(importProfileInputSchema).output(importedProfileSchema),
    /** The names of the imported profiles. */
    list: oc.output(z.array(nameSchema)),
  },
};

/** The implemented contract. */
export type DiagnosticsContract = typeof diagnosticsContract;

// ---------------------------------------------------------------------------------------------
// NEXT ADDITION: declared, not served.
//
// These operations need the OBD, live and scan modules, which the service does not yet use. They are
// declared so the next change implements a contract that already exists, and so the shapes
// (a request names a saved snapshot, never carries a token) are settled. There is no
// implementation and no stub: nothing serves this contract until those modules land.
//
// The guard's single-use tokens are issued on the implementation side. A request that clears
// codes or writes a value names the saved scan report (the snapshot) that authorises it; the
// service turns that into a `ClearToken` or `WriteToken` with `authoriseClear` or
// `authoriseWrite`. An actuator request names a duration, which the guard caps at
// `ACTUATION_MAX_MS`.
// ---------------------------------------------------------------------------------------------

const unitInput = z.object({ profile: nameSchema, adapter: nameSchema, unit: nameSchema });

/** The operations that need the unmerged OBD and live modules. Not served by anything yet. */
export const pendingDiagnosticsContract = {
  /** Reads every unit's identification and fault codes into a scan report the caller can save. */
  scan: oc
    .input(z.object({ profile: nameSchema, adapter: nameSchema }))
    .output(z.object({ report: jsonSchema })),
  /** Reads one unit's fault codes. */
  faults: oc
    .input(unitInput)
    .output(z.array(z.object({ code: nameSchema, status: z.array(z.string()) }))),
  /** Reads the freeze frame stored for one fault code. */
  freeze: oc.input(unitInput.extend({ code: nameSchema })).output(z.object({ hex: z.string() })),
  /** Clears one unit's fault codes, once the snapshot of them is saved. */
  clear: oc
    .input(unitInput.extend({ snapshot: nameSchema }))
    .output(z.object({ cleared: z.boolean() })),
  /** Writes one value, once the snapshot of its current content is saved. */
  write: oc
    .input(unitInput.extend({ name: nameSchema, hex: z.string(), snapshot: nameSchema }))
    .output(z.object({ written: z.boolean() })),
  /** Drives one actuator for at most the guard's cap. */
  actuate: oc
    .input(unitInput.extend({ name: nameSchema, durationMs: z.number().int().positive() }))
    .output(z.object({ completed: z.boolean() })),
};
