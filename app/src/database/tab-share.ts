/**
 * One database shared by every tab and window of the app.
 *
 * The `opfs-sahpool` VFS allows one connection, so exactly one tab, the leader, opens it: the tab whose database worker holds the exclusive Web Lock (`holdDatabaseLock`). Every other tab is a follower whose worker waits in the lock's queue. A follower's `Storage` and `DatabaseControl` send each call to the leader over a `BroadcastChannel` and return the leader's answer, so every tab reads and writes the same data.
 *
 * Each call travels on its own virtual channel inside the broadcast one, addressed by a call id, carrying the same messages the app already uses between a page and a worker: `serveStorage` and `remoteStorage` for storage, `serveSqlExecutor` and `createDatabaseControl` for the database file. The leader acknowledges a call's first message before it runs the call.
 *
 * When the leader goes away the browser releases its lock and grants it to the next queued worker, whose tab becomes the leader, opens the database and announces itself; a new leader therefore always means the old one is gone. Each follower then sends its unanswered calls to the new leader. A call the old leader never acknowledged never ran, so it is sent again whatever it does. A call it acknowledged but did not answer may have run, so it is sent again once only when running it twice leaves the same data ({@link REPEATABLE}); otherwise it fails with {@link HandoverError}, never silently lost and never stored twice.
 *
 * After every write the leader tells every tab, itself included, that the data changed, so lists elsewhere are read again.
 */
import { StorageError, type Storage } from "obd-read";
import { remoteStorage, serveStorage, type SupportedMessagePort } from "obd-read/web";
import {
  DatabaseUnavailableError,
  SqlWorkerError,
  createDatabaseControl,
  serveSqlExecutor,
  type DatabaseControl,
  type SqlMessagePort,
} from "obd-read/web/storage";
import type { DatabaseConnection } from "./session";

/** The broadcast channel's name. A change to the messages below that an older tab cannot read changes the name, so tabs of different versions never misread each other. */
export const TAB_CHANNEL = "obd-read-database-1";

/** Which service a call reaches on the leader. */
type Service = "storage" | "control";

/** A message on the broadcast channel. Every tab sees every message, so the ones meant for one tab name it in `to`. */
export type TabMessage =
  | { readonly kind: "who-leads" }
  | { readonly kind: "leader"; readonly leader: string }
  | {
      readonly kind: "frame";
      readonly call: string;
      readonly service: Service;
      readonly from: string;
      readonly to: string;
      /** Set on the follower's first message of a call, which the leader answers with "accepted". */
      readonly first: boolean;
      readonly payload: unknown;
    }
  | { readonly kind: "accepted"; readonly call: string; readonly to: string }
  | { readonly kind: "done"; readonly call: string; readonly to: string }
  | { readonly kind: "changed" };

/** The part of a `BroadcastChannel` this module uses, so a test can stand in for it. */
export interface TabChannel {
  postMessage(message: TabMessage): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows a received message to a {@link TabMessage}, or returns undefined for anything else. */
export function readTabMessage(data: unknown): TabMessage | undefined {
  if (!isRecord(data)) return undefined;
  switch (data.kind) {
    case "who-leads":
    case "changed":
      return { kind: data.kind };
    case "leader":
      return typeof data.leader === "string" ? { kind: "leader", leader: data.leader } : undefined;
    case "accepted":
    case "done":
      return typeof data.call === "string" && typeof data.to === "string"
        ? { kind: data.kind, call: data.call, to: data.to }
        : undefined;
    case "frame": {
      const { call, service, from, to, first, payload } = data;
      if (typeof call !== "string" || typeof from !== "string" || typeof to !== "string") {
        return undefined;
      }
      if ((service !== "storage" && service !== "control") || typeof first !== "boolean") {
        return undefined;
      }
      return { kind: "frame", call, service, from, to, first, payload };
    }
    default:
      return undefined;
  }
}

/** Every call the shared storage and control make. */
type Operation = keyof Storage | keyof DatabaseControl;

/**
 * Whether running a call twice leaves the same data as running it once, which decides how a handover treats a call the old leader acknowledged but did not answer: a repeatable call is sent to the new leader once more, any other fails with {@link HandoverError}.
 *
 * Reads, deletes, notes, profile saves (which replace by name) and file imports repeat safely. Stopping a run and saving a capture repeat safely because a repeat that finds its own earlier result reads it back instead of failing (see {@link sharedStorage}). Creating a run, saving a scan report and appending samples add new rows each time, so they are not repeated.
 */
export const REPEATABLE: Readonly<Record<Operation, boolean>> = {
  createRun: false,
  stopRun: true,
  setRunNotes: true,
  getRun: true,
  listRuns: true,
  deleteRun: true,
  appendSamples: false,
  readSamples: true,
  aggregate: true,
  saveScanReport: false,
  getScanReport: true,
  listScanReports: true,
  deleteScanReport: true,
  saveProfile: true,
  getProfile: true,
  listProfiles: true,
  saveCapture: true,
  getCapture: true,
  listCaptures: true,
  deleteCapture: true,
  info: true,
  exportFile: true,
  importFile: true,
};

/** The tab that held the database went away after it took a call that cannot safely run twice and before it answered, so whether it ran is not known. */
export class HandoverError extends Error {
  override name = "HandoverError";
}

/** The session was closed while a call was waiting. */
export class SessionClosedError extends Error {
  override name = "SessionClosedError";
}

/** One end of a virtual channel: the two port shapes the existing servers and clients take, and the means to feed and end it. */
interface VirtualPort {
  readonly orpc: SupportedMessagePort;
  readonly sql: SqlMessagePort;
  /** Hands a received payload to the listeners. */
  deliver(payload: unknown): void;
  /** Tells an oRPC client its port closed, so its pending call settles. */
  disconnect(): void;
}

function virtualPort(send: (payload: unknown) => void): VirtualPort {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const raw = new Set<(data: unknown) => void>();
  const closers = new Set<() => void>();
  return {
    orpc: {
      postMessage: send,
      onMessage: {
        addListener: (callback: (data: unknown) => void) => {
          raw.add(callback);
        },
      },
      onDisconnect: {
        addListener: (callback: () => void) => {
          closers.add(callback);
        },
      },
    },
    sql: {
      postMessage: send,
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    },
    deliver(payload) {
      for (const callback of raw) callback(payload);
      for (const listener of listeners) listener({ data: payload });
    },
    disconnect() {
      for (const close of closers) close();
    },
  };
}

/** What {@link shareDatabase} needs. */
export interface TabShareOptions {
  /** This tab's id, unique among the open tabs. */
  readonly id: string;
  /** The broadcast channel every tab of the app opened under {@link TAB_CHANNEL}. */
  readonly channel: TabChannel;
  /**
   * Resolves once this tab holds the database lock, calling `queued` first when another tab holds it. Rejects when the lock cannot be taken.
   */
  readonly lock: (queued: () => void) => Promise<void>;
  /** Opens this tab's own connection to the database. Called once, and only after `lock` resolved. */
  readonly open: () => Promise<DatabaseConnection>;
  /**
   * How long, in milliseconds, a queued tab waits for the tab holding the lock to answer before deciding that tab cannot share (an older version of the app, which does not speak this protocol). A tab answers from its message handler, so this only has to cover a busy page.
   */
  readonly answerLimit: number;
}

/** A database shared between tabs: the connection the screens use and the change notifications. */
export interface SharedDatabase {
  /** Resolves once the database answers, wherever it is open. Rejects with `DatabaseUnavailableError` when it cannot be used. */
  readonly connection: Promise<DatabaseConnection>;
  /** Calls `listener` after any tab's write. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stops taking part: pending calls reject with {@link SessionClosedError} and the channel closes. The caller ends the worker, which releases the lock. */
  close(): void;
}

/** A call waiting for an answer, so a change of leader can send it again. */
interface Pending {
  /** Sends the call to the current leader, or runs it here when this tab leads. */
  readonly route: () => void;
}

/**
 * Joins the tabs sharing the database, as leader or follower; see the module comment.
 */
export function shareDatabase(options: TabShareOptions): SharedDatabase {
  const { id, channel } = options;
  let leader: string | undefined;
  let closed = false;
  let nextCall = 0;
  const pending = new Set<Pending>();
  /** Follower side: the virtual ports of this tab's calls in flight, by call id. */
  const calls = new Map<string, { readonly port: VirtualPort; accepted: boolean }>();
  /** Leader side: the virtual ports of other tabs' calls being served, by call id. */
  const served = new Map<string, VirtualPort>();
  const listeners = new Set<() => void>();

  const post = (message: TabMessage): void => {
    if (!closed) channel.postMessage(message);
  };
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const changed = (): void => {
    notify();
    post({ kind: "changed" });
  };

  let resolveLocal: (connection: DatabaseConnection) => void = () => undefined;
  let rejectLocal: (error: unknown) => void = () => undefined;
  /** This tab's own connection, which exists only once it leads. Writes through it announce a change. */
  const local = new Promise<DatabaseConnection>((resolve, reject) => {
    resolveLocal = (connection) => {
      resolve(observeWrites(connection, changed));
    };
    rejectLocal = reject;
  });
  local.catch(() => undefined);

  const setLeader = (next: string): void => {
    if (leader === next) return;
    leader = next;
    for (const call of [...pending]) call.route();
  };

  /**
   * Runs `work` against the database wherever it is open: here when this tab leads, otherwise on the leader through a virtual channel. `work` is told whether this is a repeat after a handover.
   */
  function dispatch<T, Target>(
    operation: Operation,
    route: Route<Target>,
    work: (target: Target, repeat: boolean) => Promise<T>,
  ): Promise<T> {
    const repeatable = REPEATABLE[operation];
    return new Promise<T>((resolve, reject) => {
      /** The call in flight on a leader in another tab. */
      let attempt: { readonly call: string; readonly to: string } | undefined;
      let repeat = false;
      const finish = (outcome: () => void): void => {
        pending.delete(entry);
        if (attempt !== undefined) {
          calls.delete(attempt.call);
          post({ kind: "done", call: attempt.call, to: attempt.to });
          attempt = undefined;
        }
        outcome();
      };
      const entry: Pending = {
        route: () => {
          const previous = attempt === undefined ? undefined : calls.get(attempt.call);
          if (attempt !== undefined) calls.delete(attempt.call);
          attempt = undefined;
          previous?.port.disconnect();
          if (closed) {
            finish(() => {
              reject(new SessionClosedError("The database session was closed."));
            });
            return;
          }
          if (previous?.accepted === true) {
            if (!repeatable || repeat) {
              finish(() => {
                reject(
                  new HandoverError(
                    "The tab that held the database closed before it answered, so it is not known whether this was saved.",
                  ),
                );
              });
              return;
            }
            repeat = true;
          }
          if (leader === undefined) return;
          if (leader === id) {
            finish(() => {
              const again = repeat;
              void local
                .then((connection) => work(route.local(connection), again))
                .then(resolve, reject);
            });
            return;
          }
          nextCall += 1;
          const call = `${id}/${String(nextCall)}`;
          const to = leader;
          let first = true;
          const port = virtualPort((payload) => {
            post({ kind: "frame", call, service: route.service, from: id, to, first, payload });
            first = false;
          });
          calls.set(call, { port, accepted: false });
          const current = { call, to };
          attempt = current;
          work(route.remote(port), repeat).then(
            (value) => {
              if (attempt === current) {
                finish(() => {
                  resolve(value);
                });
              }
            },
            (error: unknown) => {
              if (attempt === current) {
                finish(() => {
                  reject(asError(error));
                });
              }
            },
          );
        },
      };
      pending.add(entry);
      entry.route();
    });
  }

  /** Serves a call another tab sent this tab while it leads. */
  function serve(frame: Extract<TabMessage, { kind: "frame" }>): void {
    const existing = served.get(frame.call);
    if (existing !== undefined) {
      existing.deliver(frame.payload);
      return;
    }
    if (!frame.first) return;
    const port = virtualPort((payload) => {
      post({
        kind: "frame",
        call: frame.call,
        service: frame.service,
        from: id,
        to: frame.from,
        first: false,
        payload,
      });
    });
    served.set(frame.call, port);
    post({ kind: "accepted", call: frame.call, to: frame.from });
    if (frame.service === "storage") {
      serveStorage(port.orpc, async () => (await local).storage);
    } else {
      serveSqlExecutor(port.sql, () => Promise.reject(new SqlWorkerError("no statements here")), {
        info: async () => (await local).control.info(),
        exportFile: async () => (await local).control.exportFile(),
        importFile: async (bytes) => {
          await (await local).control.importFile(bytes);
        },
      });
    }
    port.deliver(frame.payload);
  }

  channel.addEventListener("message", (event) => {
    const message = readTabMessage(event.data);
    if (message === undefined || closed) return;
    switch (message.kind) {
      case "who-leads":
        if (leader === id) post({ kind: "leader", leader: id });
        return;
      case "leader":
        setLeader(message.leader);
        return;
      case "changed":
        notify();
        return;
      case "accepted": {
        const call = message.to === id ? calls.get(message.call) : undefined;
        if (call !== undefined) call.accepted = true;
        return;
      }
      case "done":
        if (message.to === id) served.delete(message.call);
        return;
      case "frame":
        if (message.to !== id) return;
        if (leader === id && message.from !== id) serve(message);
        else calls.get(message.call)?.port.deliver(message.payload);
        return;
    }
  });

  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  const noAnswer = new Promise<never>((_resolve, reject) => {
    const queued = (): void => {
      post({ kind: "who-leads" });
      answerTimer = setTimeout(() => {
        if (leader === undefined && !closed) {
          reject(
            new DatabaseUnavailableError(
              "in-use",
              "The database is open in another tab or window of this app that cannot share it.",
            ),
          );
        }
      }, options.answerLimit);
    };
    options.lock(queued).then(
      () => {
        if (closed) return;
        if (answerTimer !== undefined) clearTimeout(answerTimer);
        options.open().then(resolveLocal, rejectLocal);
        setLeader(id);
        post({ kind: "leader", leader: id });
      },
      (error: unknown) => {
        reject(asError(error));
      },
    );
  });
  noAnswer.catch(() => undefined);

  const storage = sharedStorage(dispatch);
  const control = sharedControl(dispatch);
  const ready = control.info();
  const connection = Promise.race([ready, noAnswer]).then(() => ({ storage, control }));
  connection.catch(() => undefined);

  return {
    connection,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      if (answerTimer !== undefined) clearTimeout(answerTimer);
      channel.close();
      for (const call of [...pending]) call.route();
      for (const call of calls.values()) call.port.disconnect();
      calls.clear();
      served.clear();
    },
  };
}

/** How a call reaches its target: the service it uses on the leader, and the target here or over a virtual port. */
interface Route<Target> {
  readonly service: Service;
  readonly local: (connection: DatabaseConnection) => Target;
  readonly remote: (port: VirtualPort) => Target;
}

const STORAGE_ROUTE: Route<Storage> = {
  service: "storage",
  local: (connection) => connection.storage,
  remote: (port) => remoteStorage(port.orpc),
};

const CONTROL_ROUTE: Route<DatabaseControl> = {
  service: "control",
  local: (connection) => connection.control,
  remote: (port) => createDatabaseControl(port.sql),
};

type Dispatch = <T, Target>(
  operation: Operation,
  route: Route<Target>,
  work: (target: Target, repeat: boolean) => Promise<T>,
) => Promise<T>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A storage error with this code. */
function isStorageError(error: unknown, code: StorageError["code"]): boolean {
  return error instanceof StorageError && error.code === code;
}

/** The `Storage` every tab uses: each call goes through `dispatch` to wherever the database is open. */
function sharedStorage(dispatch: Dispatch): Storage {
  const on = <T>(
    operation: keyof Storage,
    work: (storage: Storage, repeat: boolean) => Promise<T>,
  ): Promise<T> => dispatch(operation, STORAGE_ROUTE, work);
  return {
    createRun: (input) => on("createRun", (s) => s.createRun(input)),
    // A repeat that finds the run already stopped at this time is the earlier attempt's result.
    stopRun: (runId, stoppedAt) =>
      on("stopRun", async (s, repeat) => {
        try {
          return await s.stopRun(runId, stoppedAt);
        } catch (error) {
          if (!repeat || !isStorageError(error, "conflict")) throw error;
          const run = await s.getRun(runId);
          if (run?.stoppedAt !== stoppedAt) throw error;
          return run;
        }
      }),
    setRunNotes: (runId, notes) => on("setRunNotes", (s) => s.setRunNotes(runId, notes)),
    getRun: (runId) => on("getRun", (s) => s.getRun(runId)),
    listRuns: (query) => on("listRuns", (s) => s.listRuns(query)),
    deleteRun: (runId) => on("deleteRun", (s) => s.deleteRun(runId)),
    appendSamples: (samples) => on("appendSamples", (s) => s.appendSamples(samples)),
    readSamples: (query) => on("readSamples", (s) => s.readSamples(query)),
    aggregate: (query) => on("aggregate", (s) => s.aggregate(query)),
    saveScanReport: (input) => on("saveScanReport", (s) => s.saveScanReport(input)),
    getScanReport: (reportId) => on("getScanReport", (s) => s.getScanReport(reportId)),
    listScanReports: (query) => on("listScanReports", (s) => s.listScanReports(query)),
    deleteScanReport: (reportId) => on("deleteScanReport", (s) => s.deleteScanReport(reportId)),
    saveProfile: (profile) => on("saveProfile", (s) => s.saveProfile(profile)),
    getProfile: (name) => on("getProfile", (s) => s.getProfile(name)),
    listProfiles: () => on("listProfiles", (s) => s.listProfiles()),
    // A repeat that finds the capture already stored under its id is the earlier attempt's result.
    saveCapture: (capture, origin) =>
      on("saveCapture", async (s, repeat) => {
        try {
          return await s.saveCapture(capture, origin);
        } catch (error) {
          if (!repeat || !isStorageError(error, "conflict")) throw error;
          const stored = (await s.listCaptures({ origin })).find(({ id }) => id === capture.id);
          if (stored === undefined) throw error;
          return stored;
        }
      }),
    getCapture: (captureId) => on("getCapture", (s) => s.getCapture(captureId)),
    listCaptures: (query) => on("listCaptures", (s) => s.listCaptures(query)),
    deleteCapture: (captureId) => on("deleteCapture", (s) => s.deleteCapture(captureId)),
  };
}

/** The `DatabaseControl` every tab uses: each call goes through `dispatch` to wherever the database is open. */
function sharedControl(dispatch: Dispatch): DatabaseControl {
  return {
    info: () => dispatch("info", CONTROL_ROUTE, (c) => c.info()),
    exportFile: () => dispatch("exportFile", CONTROL_ROUTE, (c) => c.exportFile()),
    importFile: (bytes) => dispatch("importFile", CONTROL_ROUTE, (c) => c.importFile(bytes)),
  };
}

/** The leader's own connection, announcing a change after each write succeeds. */
function observeWrites(connection: DatabaseConnection, changed: () => void): DatabaseConnection {
  const after = async <T>(work: Promise<T>): Promise<T> => {
    const value = await work;
    changed();
    return value;
  };
  const { storage: s, control: c } = connection;
  return {
    storage: {
      createRun: (input) => after(s.createRun(input)),
      stopRun: (runId, stoppedAt) => after(s.stopRun(runId, stoppedAt)),
      setRunNotes: (runId, notes) => after(s.setRunNotes(runId, notes)),
      getRun: (runId) => s.getRun(runId),
      listRuns: (query) => s.listRuns(query),
      deleteRun: (runId) => after(s.deleteRun(runId)),
      appendSamples: (samples) => after(s.appendSamples(samples)),
      readSamples: (query) => s.readSamples(query),
      aggregate: (query) => s.aggregate(query),
      saveScanReport: (input) => after(s.saveScanReport(input)),
      getScanReport: (reportId) => s.getScanReport(reportId),
      listScanReports: (query) => s.listScanReports(query),
      deleteScanReport: (reportId) => after(s.deleteScanReport(reportId)),
      saveProfile: (profile) => after(s.saveProfile(profile)),
      getProfile: (name) => s.getProfile(name),
      listProfiles: () => s.listProfiles(),
      saveCapture: (capture, origin) => after(s.saveCapture(capture, origin)),
      getCapture: (captureId) => s.getCapture(captureId),
      listCaptures: (query) => s.listCaptures(query),
      deleteCapture: (captureId) => after(s.deleteCapture(captureId)),
    },
    control: {
      info: () => c.info(),
      exportFile: () => c.exportFile(),
      importFile: (bytes) => after(c.importFile(bytes)),
    },
  };
}
