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
import { captureStatusSchema, startCaptureInputSchema } from "./capture-jobs.js";
import { obdScanSchema } from "./obd-scan.js";
import { planSchema } from "./plan.js";
import { planEventSchema, planStatusSchema } from "./plan-jobs.js";
import { plateAssignmentSchema, vehicleRegisterSchema, vehicleSchema } from "./vehicles.js";
import { TABLE_FORMATS } from "./tabular.js";
import { SCHEMES } from "./transport.js";
import {
  aggregateQuerySchema,
  captureQuerySchema,
  captureSummarySchema,
  plateSchema,
  storedCaptureSchema,
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
  /** The profile to collect for: a shipped profile or one imported earlier. Omitted for a generic OBD-II run, which collects the legislated values only and so cannot name a `unit`. */
  profile: nameSchema.optional(),
  /** The adapter URL, such as `ble://vLinker` or `simulator://mercedes-w211`. */
  adapter: nameSchema,
  notes: z.string().optional(),
});

/** What a caller gives to start a collection run. */
export type StartRunInput = z.output<typeof startRunInputSchema>;

/** The file formats a run can be exported in: CSV, TSV and JSON. */
export const EXPORT_FORMATS = TABLE_FORMATS;

/** What a caller gives to import a run: the text of its CSV or TSV export and the file's name for the run's record. */
export const importRunInputSchema = z.object({ text: z.string(), name: nameSchema });

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
  /** The value being requested now, or `null` before the first request and while reconnecting. */
  progress: z
    .object({
      position: z.number().int().positive(),
      total: z.number().int().positive(),
      label: z.string(),
    })
    .nullable(),
});

/** The legislated values the connected car supports. */
export const supportedValuesSchema = z.object({
  values: z.array(
    z.object({
      /** The name `runs.start` selects the value by in `signals`. */
      name: nameSchema,
      /** The readings the value yields; each becomes a sample under its label. */
      columns: z.array(z.object({ label: z.string(), unit: z.string() })).min(1),
    }),
  ),
  /** How long one request of the adapter took, in milliseconds, measured by reading the first value. */
  requestMs: z.number().nonnegative(),
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
  /** The profile the connection was opened with, or `null` for a generic OBD-II connection. */
  profile: nameSchema.nullable(),
  /** The adapter URL it was opened with. */
  adapter: nameSchema,
  /** Whether the data comes from the simulator and not from a car. */
  simulated: z.boolean(),
  info: adapterInfoSchema,
  /** The number plate the user gave this connection's car, upper case without spaces or hyphens; `null` until one is given. */
  plate: plateSchema,
});

/** The open connection. */
export type Connection = z.output<typeof connectionSchema>;

/** What a caller gives to open a connection. */
export const connectInputSchema = z.object({
  /** A shipped or imported profile; omitted for a generic OBD-II connection (the legislated services only). */
  profile: nameSchema.optional(),
  adapter: nameSchema,
});

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

/** One of a profile's named values, decoded from a capture. */
export const decodedValueSchema = z.object({
  unit: nameSchema,
  name: nameSchema,
  label: z.string(),
  measure: z.string(),
  /** The number, or why the reply could not be decoded. */
  value: z.union([z.number(), z.object({ error: z.string() })]),
  /** The exchange it came from. */
  seq: z.number().int().nonnegative(),
});

/** What a capture says under one profile or none, as a caller shows it. */
export const decodedCaptureSchema = z.object({
  /** The profile decoded with, or `null` for none. */
  profile: z.object({ name: nameSchema, status: z.string() }).nullable(),
  units: z.array(unitReportSchema),
  obd: obdScanSchema.nullable(),
  values: z.array(decodedValueSchema),
  discovered: z.array(
    z.object({
      requestId: z.number().int().nonnegative(),
      responseId: z.number().int().nonnegative(),
      accepted: z.boolean(),
      detail: z.string(),
    }),
  ),
  /** The sequence numbers of the exchanges no reader used. */
  undecoded: z.array(z.number().int().nonnegative()),
  exchanges: z.number().int().nonnegative(),
  /** The decoded capture as the `decode` command prints it. */
  lines: z.array(z.string()),
});

/** What a capture says under one profile or none. */
export type DecodedCaptureData = z.output<typeof decodedCaptureSchema>;

/** What a caller gives to import a record as a capture: its text and a name for messages. */
export const importCaptureInputSchema = z.object({
  /** A capture document, a saved scan (`scan --output`) or an adapter transcript (`--log`). */
  text: z.string(),
  name: nameSchema,
});

/** The outcome of importing a record as a capture. */
export const importedCaptureSchema = z.object({
  summary: captureSummarySchema,
  /** What the record held that could not be turned into exchanges. */
  unrecovered: z.array(z.string()),
});

/** Which plan to start: a shipped one by name, or the text of a plan file the user chose. */
export const startPlanInputSchema = z.object({
  plan: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shipped"), name: nameSchema }),
    z.object({
      kind: z.literal("file"),
      /** The file's JSON text. */
      text: z.string(),
      /** The file's name, for messages. */
      name: nameSchema,
    }),
  ]),
});

/** What a caller gives to start a plan. */
export type StartPlanInput = z.output<typeof startPlanInputSchema>;

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
    /** Opens the adapter, initialises it and selects the profile's bus; rejects when already connected. With no profile the connection is generic OBD-II: it reads and clears through the legislated services only, and every operation that addresses one unit rejects with `PROFILE_REQUIRED`. */
    connect: oc.input(connectInputSchema).output(connectionSchema),
    /** Closes the connection; does nothing when there is none. */
    disconnect: oc.output(z.object({ disconnected: z.boolean() })),
    /** Asks every unit of the profile for its session without reading codes. Rejects with `PROFILE_REQUIRED` on a generic connection. */
    probe: oc.output(z.object({ adapter: adapterInfoSchema, units: z.array(unitReportSchema) })),
    /** Gives the open connection's car a number plate, or takes it away with `null`, so the runs, captures and reports saved on this connection record it; a new connection starts with none. Nothing is looked up. Rejects with `PRECONDITION_FAILED` when not connected. */
    setPlate: oc.input(z.object({ plate: plateSchema })).output(connectionSchema),
  },
  vehicles: {
    /** Every vehicle the register holds and every plate assignment. */
    list: oc.output(vehicleRegisterSchema),
    /** Stores a vehicle's VIN and label; rejects with `CONFLICT` when another vehicle has that VIN. */
    save: oc.input(vehicleSchema).output(vehicleRegisterSchema),
    /** Stores a plate assignment (a new one, a changed start, or an end that marks the plate moved off the vehicle); rejects with `CONFLICT` when the plate is assigned for an overlapping period already, `BAD_REQUEST` for a period that ends before it starts. */
    savePlate: oc.input(plateAssignmentSchema).output(vehicleRegisterSchema),
    /** Removes a plate assignment. */
    deletePlate: oc.input(z.object({ id: nameSchema })).output(vehicleRegisterSchema),
    /** Merges one vehicle record into another that turned out to be the same car; rejects with `CONFLICT` when their VINs differ or their plates overlap. */
    merge: oc
      .input(z.object({ keep: nameSchema, remove: nameSchema }))
      .output(vehicleRegisterSchema),
  },
  units: {
    /** One unit's identification. Rejects with `PROFILE_REQUIRED` on a generic connection, as do `faults` and `freeze`. */
    ident: oc.input(unitInput).output(unitReportSchema),
    /** One unit's identification and stored fault codes. */
    faults: oc.input(unitInput).output(unitReportSchema),
    /** One unit's identification, fault codes and the freeze frame stored with each. */
    freeze: oc.input(unitInput).output(unitReportSchema),
  },
  scan: {
    /**
     * Reads every unit's identification and fault codes, and saves the result as a scan report. On a generic connection it reads the legislated OBD-II services instead: `obd` holds the structured report and `units` has one entry per answering emissions unit (its stored, pending and permanent codes as faults, its freeze frame and the VIN as identification), so the same views show both. `obd` is `null` for a profile scan.
     */
    run: oc
      .input(z.object({ freeze: z.boolean().default(false), label: z.string().default("") }))
      .output(
        z.object({
          report: scanReportSummarySchema,
          units: z.array(unitReportSchema),
          obd: obdScanSchema.nullable(),
        }),
      ),
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
     * Reads what a clear would erase, saves it as a snapshot and returns what would be sent. Sends nothing that changes the car. The target is one unit's fault codes (needs a profile, else `PROFILE_REQUIRED`), or the legislated mode 04 clear that erases every emissions-related unit's codes, which a generic connection can do.
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
    /** Reads the current value, saves it as a snapshot and returns what would be written. Rejects with `PROFILE_REQUIRED` on a generic connection. */
    request: oc
      .input(z.object({ unit: nameSchema, request: hexRequest, read: hexRequest }))
      .output(guardedRequestSchema),
    /** Answers yes to a pending write: sends it once through the guard and reads the value back. */
    confirm: oc.input(confirmInput).output(guardedOutcomeSchema),
  },
  actuate: {
    /** Checks an actuator test and returns what would be sent; the guard caps the duration at 30 seconds. Rejects with `PROFILE_REQUIRED` on a generic connection. */
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
    /** Opens a run and starts collecting; the run is returned open. A run with no profile is stored under the name `generic-obd2` and collects the legislated values; naming a `unit` without a profile rejects with `PROFILE_REQUIRED`. */
    start: oc.input(startRunInputSchema).output(runSchema),
    /** Collects again for a run that is open and not being collected, as after a reload; it keeps what the run was started with. Rejects with `CONFLICT` for a run that is not `local`, since a shared or imported run was not read here, and for a run a recording plan recorded, since a plan does not resume. */
    resume: oc.input(runIdInput).output(runSchema),
    /** The legislated values the connected car supports, for choosing what a run collects, with the time one request took. Needs the adapter free: no collection run, plan or capture. */
    values: oc.output(supportedValuesSchema),
    /** Stops collecting for a run and closes it. A cycle in progress ends before its next request, so the call returns within the request in flight. */
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
    /** A run as CSV, TSV or JSON text for the caller to save. */
    export: oc
      .input(z.object({ runId: nameSchema, format: z.enum(EXPORT_FORMATS) }))
      .output(exportedRunSchema),
    /** Keeps a run read from its CSV or TSV export as a stopped run of origin `imported`. Rejects with `BAD_REQUEST` naming the first header column that is not the export's. */
    import: oc.input(importRunInputSchema).output(runSchema),
  },
  live: {
    /**
     * Samples as they are collected, from the moment of the call until the caller stops iterating. Samples already stored are not replayed: read them with `runs.samples`. A subscriber that falls too far behind is ended with an error rather than silently losing samples.
     */
    samples: oc.input(liveSamplesInputSchema).output(asyncIteratorObject(sampleSchema)),
  },
  captures: {
    /**
     * Starts capturing everything the car offers on the open connection, through the read-only services only, and returns at once; the capture is saved when it ends. With a profile it reads every unit of the profile; with none it sweeps the `discovery` range for units. An `identifiers` sweep runs only when given. Rejects with `CONFLICT` while a capture, a collection run or a confirmation holds the adapter.
     */
    start: oc.input(startCaptureInputSchema).output(captureStatusSchema),
    /** Asks a running capture to stop after the request in flight; it is saved as incomplete. Rejects with `NOT_FOUND` for an unknown id. */
    stop: oc.input(z.object({ id: nameSchema })).output(captureStatusSchema),
    /** A capture's status, or `null` for an id this host did not start. */
    status: oc.input(z.object({ id: nameSchema })).output(captureStatusSchema.nullable()),
    /** The capture's status now and at each change, ending when it ends. */
    progress: oc
      .input(z.object({ id: nameSchema }))
      .output(asyncIteratorObject(captureStatusSchema)),
    /** Stored captures without their exchanges, newest first. */
    list: oc.input(captureQuerySchema).output(z.array(captureSummarySchema)),
    /** One stored capture with every exchange; rejects with `NOT_FOUND` when there is none. */
    get: oc.input(z.object({ id: nameSchema })).output(storedCaptureSchema),
    /** Removes a stored capture. */
    delete: oc.input(z.object({ id: nameSchema })).output(z.object({ deleted: z.boolean() })),
    /** Keeps a capture document, or imports a saved scan or an adapter transcript as one, listing what could not be recovered. Rejects with `BAD_REQUEST` for anything else and `CONFLICT` for a capture id stored already. */
    import: oc.input(importCaptureInputSchema).output(importedCaptureSchema),
    /**
     * Decodes a stored capture under a shipped or imported profile, or under none with `profile: null`. The decoding reads the profile as it is now, so an updated profile re-decodes an old capture. Nothing is sent to the car.
     */
    decode: oc
      .input(
        z.object({
          id: nameSchema,
          profile: nameSchema.nullable(),
          /** Decode only the first this many exchanges, with each repeated request taken at its latest read: the capture as it stood part-way through, for playback. Omitted, the whole capture is decoded as it always was. */
          exchanges: z.int().min(0).optional(),
        }),
      )
      .output(decodedCaptureSchema),
  },
  plans: {
    /** The shipped recording plans, sorted by name. */
    list: oc.output(z.array(planSchema)),
    /**
     * Validates a plan and starts it on the open connection, and returns once its run exists; the run is stored as it goes and stopped when the plan ends, however it ends. Plans read the car through the read-only legislated services only. Rejects with `BAD_REQUEST` for an invalid plan, listing every problem and, for an unknown value name, the valid names, or for a value the car does not report; `PRECONDITION_FAILED` with no connection; `CONFLICT` while a plan, a collection run, a capture or a confirmation holds the adapter.
     */
    start: oc.input(startPlanInputSchema).output(planStatusSchema),
    /** A plan's status, or `null` for a run no plan runs or ran here (as after a reload). */
    status: oc.input(runIdInput).output(planStatusSchema.nullable()),
    /** The plan's events so far (of samples and progress only the latest of the phase), then each new one, ending after `finished`. Ends at once for a run no plan runs here. */
    events: oc.input(runIdInput).output(asyncIteratorObject(planEventSchema)),
    /** Answers the confirmation the current wait asks for; does nothing when none is asked. Rejects with `NOT_FOUND` for a run no plan ran here. */
    confirm: oc.input(runIdInput).output(planStatusSchema),
    /** Ends the current phase as skipped, after its end reads, and goes on to the next. */
    skip: oc.input(runIdInput).output(planStatusSchema),
    /** Ends the plan at its next step; the run is kept and stopped. */
    abort: oc.input(runIdInput).output(planStatusSchema),
    /**
     * Of `runIds`, stops every open run a plan recorded that no plan runs here, as after a reload, at its last reading: a plan never resumes, because its phases depend on what the person was doing. The caller names the runs, so a page leaves alone a run another page is still recording into. Returns the runs it stopped, so a page can say so; an unknown id is skipped.
     */
    recover: oc.input(z.object({ runIds: z.array(nameSchema) })).output(z.array(runSchema)),
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
