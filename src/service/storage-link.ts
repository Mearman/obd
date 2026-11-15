/**
 * A {@link Storage} reached over a message port: how a worker uses the one storage the page opened.
 *
 * The page owns the database (one connection, one writer), and the service worker needs it too. {@link serveStorage} runs on the page and answers each call from the storage its supplier returns at that moment; {@link remoteStorage} runs in the worker and is a `Storage` whose methods call across. Data crosses as the same plain values the interface already restricts itself to. A `StorageError` crosses with its code and comes back as a `StorageError`.
 *
 * The supplier is called for every request, so the page can swap the storage under a running worker (a database that opened late, a retry) and hold requests until there is one.
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink, type SupportedMessagePort } from "@orpc/client/message-port";
import { oc, type RouterContractClient } from "@orpc/contract";
import { ORPCError, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { z } from "zod";
import {
  StorageError,
  aggregateQuerySchema,
  newRunSchema,
  newScanReportSchema,
  runQuerySchema,
  runSchema,
  sampleQuerySchema,
  sampleSchema,
  scanReportQuerySchema,
  scanReportSchema,
  scanReportSummarySchema,
  signalAggregateSchema,
  storedProfileSchema,
  type Storage,
  type StorageErrorCode,
} from "../core/storage.js";
import { startPort } from "./message-port.js";

const name = z.string().min(1);
const done = z.object({ done: z.literal(true) });

/** The storage operations a page serves. Records that may be absent are `null` on the wire. */
export const storageContract = {
  createRun: oc.input(newRunSchema).output(runSchema),
  stopRun: oc.input(z.object({ runId: name, stoppedAt: z.number() })).output(runSchema),
  setRunNotes: oc.input(z.object({ runId: name, notes: z.string() })).output(runSchema),
  getRun: oc.input(z.object({ runId: name })).output(runSchema.nullable()),
  listRuns: oc.input(runQuerySchema).output(z.array(runSchema)),
  deleteRun: oc.input(z.object({ runId: name })).output(done),
  appendSamples: oc.input(z.object({ samples: z.array(sampleSchema) })).output(done),
  readSamples: oc.input(sampleQuerySchema).output(z.array(sampleSchema)),
  aggregate: oc.input(aggregateQuerySchema).output(z.array(signalAggregateSchema)),
  saveScanReport: oc.input(newScanReportSchema).output(scanReportSchema),
  getScanReport: oc.input(z.object({ id: name })).output(scanReportSchema.nullable()),
  listScanReports: oc.input(scanReportQuerySchema).output(z.array(scanReportSummarySchema)),
  deleteScanReport: oc.input(z.object({ id: name })).output(done),
  saveProfile: oc.input(storedProfileSchema).output(z.object({ replaced: z.boolean() })),
  getProfile: oc.input(z.object({ name })).output(storedProfileSchema.nullable()),
  listProfiles: oc.output(z.array(storedProfileSchema)),
};

const CODES: Readonly<Record<StorageErrorCode, string>> = {
  "not-found": "NOT_FOUND",
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
};

const ERROR_CODES: ReadonlyMap<string, StorageErrorCode> = new Map([
  ["NOT_FOUND", "not-found"],
  ["CONFLICT", "conflict"],
  ["BAD_REQUEST", "invalid"],
]);

/**
 * Serves the storage `current` returns on `port`.
 *
 * @param current Called for every request; it may wait until a storage exists, or reject to fail the request.
 */
export function serveStorage(port: SupportedMessagePort, current: () => Promise<Storage>): void {
  const os = implement(storageContract);
  const through = async <T>(use: (storage: Storage) => Promise<T>): Promise<T> => {
    try {
      return await use(await current());
    } catch (error) {
      if (error instanceof StorageError) {
        throw new ORPCError(CODES[error.code], { message: error.message });
      }
      // The page's failure to open the database must reach the worker with its reason, not as a masked internal error.
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const finished = { done: true } as const;
  const router = os.router({
    createRun: os.createRun.handler(({ input }) => through((s) => s.createRun(input))),
    stopRun: os.stopRun.handler(({ input }) =>
      through((s) => s.stopRun(input.runId, input.stoppedAt)),
    ),
    setRunNotes: os.setRunNotes.handler(({ input }) =>
      through((s) => s.setRunNotes(input.runId, input.notes)),
    ),
    getRun: os.getRun.handler(({ input }) =>
      through(async (s) => (await s.getRun(input.runId)) ?? null),
    ),
    listRuns: os.listRuns.handler(({ input }) => through((s) => s.listRuns(input))),
    deleteRun: os.deleteRun.handler(({ input }) =>
      through(async (s) => {
        await s.deleteRun(input.runId);
        return finished;
      }),
    ),
    appendSamples: os.appendSamples.handler(({ input }) =>
      through(async (s) => {
        await s.appendSamples(input.samples);
        return finished;
      }),
    ),
    readSamples: os.readSamples.handler(({ input }) => through((s) => s.readSamples(input))),
    aggregate: os.aggregate.handler(({ input }) => through((s) => s.aggregate(input))),
    saveScanReport: os.saveScanReport.handler(({ input }) =>
      through((s) => s.saveScanReport(input)),
    ),
    getScanReport: os.getScanReport.handler(({ input }) =>
      through(async (s) => (await s.getScanReport(input.id)) ?? null),
    ),
    listScanReports: os.listScanReports.handler(({ input }) =>
      through((s) => s.listScanReports(input)),
    ),
    deleteScanReport: os.deleteScanReport.handler(({ input }) =>
      through(async (s) => {
        await s.deleteScanReport(input.id);
        return finished;
      }),
    ),
    saveProfile: os.saveProfile.handler(({ input }) => through((s) => s.saveProfile(input))),
    getProfile: os.getProfile.handler(({ input }) =>
      through(async (s) => (await s.getProfile(input.name)) ?? null),
    ),
    listProfiles: os.listProfiles.handler(() => through((s) => s.listProfiles())),
  });
  new RPCHandler(router).upgrade(port);
  startPort(port);
}

type StorageClient = RouterContractClient<typeof storageContract>;

/** A storage whose calls are answered by {@link serveStorage} on the other end of `port`. */
export function remoteStorage(port: SupportedMessagePort): Storage {
  const client: StorageClient = createORPCClient(new RPCLink({ port }));
  startPort(port);
  const through = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      const code = error instanceof ORPCError ? ERROR_CODES.get(error.code) : undefined;
      if (code !== undefined && error instanceof Error) throw new StorageError(code, error.message);
      if (error instanceof ORPCError) throw new Error(error.message, { cause: error });
      throw error;
    }
  };
  return {
    createRun: (input) => through(() => client.createRun(input)),
    stopRun: (runId, stoppedAt) => through(() => client.stopRun({ runId, stoppedAt })),
    setRunNotes: (runId, notes) => through(() => client.setRunNotes({ runId, notes })),
    getRun: async (runId) => (await through(() => client.getRun({ runId }))) ?? undefined,
    listRuns: (query = {}) => through(() => client.listRuns(query)),
    deleteRun: async (runId) => {
      await through(() => client.deleteRun({ runId }));
    },
    appendSamples: async (samples) => {
      await through(() => client.appendSamples({ samples: [...samples] }));
    },
    readSamples: (query) => through(() => client.readSamples(query)),
    aggregate: (query) => through(() => client.aggregate(query)),
    saveScanReport: (input) => through(() => client.saveScanReport(input)),
    getScanReport: async (id) => (await through(() => client.getScanReport({ id }))) ?? undefined,
    listScanReports: (query = {}) => through(() => client.listScanReports(query)),
    deleteScanReport: async (id) => {
      await through(() => client.deleteScanReport({ id }));
    },
    saveProfile: (profile) => through(() => client.saveProfile(profile)),
    getProfile: async (profileName) =>
      (await through(() => client.getProfile({ name: profileName }))) ?? undefined,
    listProfiles: () => through(() => client.listProfiles()),
  };
}
