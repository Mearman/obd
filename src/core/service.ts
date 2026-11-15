/**
 * The `DiagnosticsService` contract: what a UI (a page, a CLI, a phone) may ask of the machine that holds the adapter and the storage.
 *
 * The contract is written once with oRPC (`@orpc/contract`, Zod schemas as Standard Schema) and implemented at the edge: in process (`service-impl.ts`), in a dedicated worker over a message port, or in a Node daemon over a socket. The guard runs on the implementation side, so no client can bypass it. Transports, ELM and the protocol layers stay plain async interfaces below this line.
 *
 * Operations that change the car (clear, write, actuate) are two calls each. A `request` call runs the command until it would ask the user, and returns what it would send and the snapshot it saved; a `confirm` call carrying the returned confirmation id answers yes, and `guarded.cancel` answers no. The guard's single-use tokens exist only inside the host: the confirmation id is an opaque handle to a parked command, never a token, and no client mints anything.

Usage and times follow {@link Storage}: times are integer milliseconds since the Unix epoch.
 */

import { asyncIteratorObject, oc } from "@orpc/contract";
import { z } from "zod";
import { SCHEMES } from "./transport.js";
import {
  aggregateQuerySchema,
  runQuerySchema,
  runSchema,
  sampleQuerySchema,
  sampleSchema,
  scanReportQuerySchema,
  scanReportSchema,
  scanReportSummarySchema,
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

/** What a run collects: the named values of one unit in the profile, or the legislated values the car supports. */
export const collectionRequestSchema = z.object({
  /** A unit in the profile whose named values to poll; omitted means the legislated OBD-II values. */
  unit: nameSchema.optional(),
  /** The values to poll, by name; omitted means every value available. */
  signals: z.array(nameSchema).min(1).optional(),
});

/** What a caller gives to start a collection run. */
export const startRunInputSchema = collectionRequestSchema.extend({
  /** The profile to collect for: a shipped profile or one imported earlier. */
  profile: nameSchema,
  /** The adapter URL, such as `ble://vLinker` or `simulator://mercedes-w211`. */
  adapter: nameSchema,
  notes: z.string().optional(),
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

const timestampSchema = z.number().int().nonnegative();

/** How a run's collection is going. */
export const collectionStatusSchema = z.object({
  state: z.enum(["collecting", "reconnecting", "failed"]),
  /** Reconnection attempts since the link last worked. */
  attempt: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** Samples stored since collection started in this process. */
  samples: z.number().int().nonnegative(),
});

/** What the adapter said about itself. */
export const adapterInfoSchema = z.object({
  identity: z.string(),
  description: z.string().nullable(),
  stnIdentity: z.string().nullable(),
  voltage: z.string().nullable(),
  hasStnExtensions: z.boolean(),
});

/** The open connection. */
export const connectionSchema = z.object({
  profile: nameSchema,
  /** The adapter URL it was opened with. */
  adapter: nameSchema,
  /** Whether the data comes from the simulator and not from a car. */
  simulated: z.boolean(),
  info: adapterInfoSchema,
});

/** The open connection. */
export type Connection = z.output<typeof connectionSchema>;

/** What a caller gives to open a connection. */
export const connectInputSchema = z.object({ profile: nameSchema, adapter: nameSchema });

/** What one control unit said. */
export const unitReportSchema = z.object({
  unit: nameSchema,
  description: z.string(),
  /** The request identifier as upper-case hexadecimal. */
  requestId: z.string(),
  /** The response identifier as upper-case hexadecimal. */
  responseId: z.string(),
  answered: z.boolean(),
  notes: z.array(z.string()),
  identification: z.array(z.object({ label: nameSchema, hex: z.string(), text: z.string() })),
  /** The stored fault codes with their status bytes, or `null` when they were not read. */
  faults: z.array(z.object({ code: nameSchema, status: z.string() })).nullable(),
  /** The raw freeze frame, or why there is none, by fault code. */
  freezeFrames: z.record(z.string(), z.string()),
});

/** What one control unit said. */
export type UnitReportData = z.output<typeof unitReportSchema>;

const unitInput = z.object({ unit: nameSchema });

const hexRequest = z
  .string()
  .regex(/^\s*([0-9a-fA-F]{2}\s*)+$/, "hexadecimal bytes, such as 2E 01 02")
  .describe("Request bytes in hexadecimal; spaces are ignored.");

/** What a guarded command is waiting to have confirmed. */
export const guardedRequestSchema = z.object({
  /** The id the confirming call carries; it passes once. */
  confirmation: nameSchema,
  /** The question the command asked. */
  prompt: z.string(),
  /** What the command printed before asking: what would be sent, and the snapshot. */
  lines: z.array(z.string()),
  /** The snapshot saved before asking, or `null` when the command saves none. */
  snapshot: z.object({ id: nameSchema, name: nameSchema }).nullable(),
  /** When the confirmation expires, in milliseconds since the Unix epoch. */
  expiresAt: timestampSchema,
});

/** What a guarded command is waiting to have confirmed. */
export type GuardedRequestData = z.output<typeof guardedRequestSchema>;

/** How a guarded command ended. */
export const guardedOutcomeSchema = z.object({
  /** Whether the answer was yes. */
  confirmed: z.boolean(),
  /** 0 when the command did what it was asked, 1 when it was declined or the result did not match. */
  exitStatus: z.number().int(),
  /** Everything the command printed, from the start. */
  lines: z.array(z.string()),
});

/** How a guarded command ended. */
export type GuardedOutcomeData = z.output<typeof guardedOutcomeSchema>;

const confirmInput = z.object({ confirmation: nameSchema });

/** Which browser device grant a page hands the worker that hosts the service. */
export const deviceGrantSchema = z.object({
  scheme: z.enum(["webserial", "webusb"]),
  /** The USB vendor id of the granted device, to pick it from the granted list. */
  vendorId: z.number().int().nonnegative().optional(),
  productId: z.number().int().nonnegative().optional(),
  serialNumber: z.string().optional(),
});

/** A device the page's picker granted. */
export type DeviceGrant = z.output<typeof deviceGrantSchema>;

/** The operations of the service. */
export const diagnosticsContract = {
  adapters: {
    /** Every adapter scheme with whether this host serves it. */
    list: oc.output(z.array(adapterCapabilitySchema)),
    /**
     * Hands the host a device the page's picker granted, so a transport that runs in a worker can use it. The picker needs a user gesture and runs on the page; the worker cannot show one.
     */
    grant: oc.input(deviceGrantSchema).output(z.object({ scheme: z.enum(SCHEMES) })),
  },
  link: {
    /** The open connection, or `null`. */
    status: oc.output(connectionSchema.nullable()),
    /** Opens the adapter, initialises it and selects the profile's bus; rejects when already connected. */
    connect: oc.input(connectInputSchema).output(connectionSchema),
    /** Closes the connection; does nothing when there is none. */
    disconnect: oc.output(z.object({ disconnected: z.boolean() })),
    /** Asks every unit of the profile for its session without reading codes. */
    probe: oc.output(z.object({ adapter: adapterInfoSchema, units: z.array(unitReportSchema) })),
  },
  units: {
    /** One unit's identification. */
    ident: oc.input(unitInput).output(unitReportSchema),
    /** One unit's identification and stored fault codes. */
    faults: oc.input(unitInput).output(unitReportSchema),
    /** One unit's identification, fault codes and the freeze frame stored with each. */
    freeze: oc.input(unitInput).output(unitReportSchema),
  },
  scan: {
    /** Reads every unit's identification and fault codes, and saves the result as a scan report. */
    run: oc
      .input(z.object({ freeze: z.boolean().default(false), label: z.string().default("") }))
      .output(z.object({ report: scanReportSummarySchema, units: z.array(unitReportSchema) })),
  },
  reports: {
    /** Saved scan reports and snapshots, newest first. */
    list: oc.input(scanReportQuerySchema).output(z.array(scanReportSummarySchema)),
    /** One saved report with its body; rejects with `NOT_FOUND` when there is none. */
    get: oc.input(z.object({ id: nameSchema })).output(scanReportSchema),
  },
  battery: {
    /** The adapter's own supply voltage reading, in volts. */
    voltage: oc.output(z.object({ volts: z.number() })),
  },
  monitor: {
    /**
     * Listens to CAN traffic for a limited time and returns the log lines. Transmits nothing. Needs the adapter free: no connection and no collection run.
     */
    capture: oc
      .input(
        z.object({
          adapter: nameSchema,
          idBits: z.union([z.literal(11), z.literal(29)]),
          bitrate: z.number().int().positive(),
          durationMs: z.number().int().positive().max(60_000),
          count: z.number().int().positive().optional(),
        }),
      )
      .output(z.object({ lines: z.array(z.string()) })),
  },
  clear: {
    /**
     * Reads what a clear would erase, saves it as a snapshot and returns what would be sent. Sends nothing that changes the car. The target is one unit's fault codes, or the legislated mode 04 clear that erases every emissions-related unit's codes.
     */
    request: oc
      .input(
        z.object({
          target: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("unit"), unit: nameSchema }),
            z.object({ kind: z.literal("obd") }),
          ]),
        }),
      )
      .output(guardedRequestSchema),
    /** Answers yes to a pending clear: sends it through the guard and reads the codes again. */
    confirm: oc.input(confirmInput).output(guardedOutcomeSchema),
  },
  write: {
    /** Reads the current value, saves it as a snapshot and returns what would be written. */
    request: oc
      .input(z.object({ unit: nameSchema, request: hexRequest, read: hexRequest }))
      .output(guardedRequestSchema),
    /** Answers yes to a pending write: sends it once through the guard and reads the value back. */
    confirm: oc.input(confirmInput).output(guardedOutcomeSchema),
  },
  actuate: {
    /** Checks an actuator test and returns what would be sent; the guard caps the duration at 30 seconds. */
    request: oc
      .input(
        z.object({
          unit: nameSchema,
          request: hexRequest,
          stop: hexRequest,
          durationMs: z.number().int().positive(),
        }),
      )
      .output(guardedRequestSchema),
    /** Answers yes to a pending actuator test: starts it, holds, and always sends the stop request. */
    confirm: oc.input(confirmInput).output(guardedOutcomeSchema),
  },
  guarded: {
    /** Answers no to a pending clear, write or actuator test: nothing is sent and the snapshot stays. */
    cancel: oc.input(confirmInput).output(guardedOutcomeSchema),
  },
  runs: {
    /** Opens a run and starts collecting; the run is returned open. */
    start: oc.input(startRunInputSchema).output(runSchema),
    /** Collects again for a run that is open and not being collected, as after a reload; it keeps what the run was started with. */
    resume: oc.input(runIdInput).output(runSchema),
    /** Stops collecting for a run and closes it. */
    stop: oc.input(runIdInput).output(runSchema),
    /** How a run's collection is going, or `null` for a run this host is not collecting. */
    status: oc.input(runIdInput).output(collectionStatusSchema.nullable()),
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

/** The service's contract. */
export type DiagnosticsContract = typeof diagnosticsContract;
