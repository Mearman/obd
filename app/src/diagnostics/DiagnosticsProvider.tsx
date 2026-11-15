import { isSimulatorUrl, type Connection, type PlanStatus, type Run, type Sample } from "obd-read";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { adapterUrl } from "../connect/adapters";
import { useActivity } from "../pwa/ActivityProvider";
import { DiagnosticsError, type AdapterKind, type AppService } from "./client";
import { collectedElsewhere, runClaims } from "./run-claims";
import { useWakeLock } from "./useWakeLock";

/** How a collection run is going, as the screens show it. */
export interface CollectionView {
  /** The run being collected, or undefined when none is. */
  readonly run: Run | undefined;
  /** `collecting`, `reconnecting` or `failed`; undefined when no run is being collected. */
  readonly state: "collecting" | "reconnecting" | "failed" | undefined;
  /** The last error the collector saw, or null. */
  readonly lastError: string | null;
  /** The newest reading of each signal, ordered by name. */
  readonly latest: readonly Sample[];
  /** The value the collector is requesting now, or null before its first request. */
  readonly progress: {
    readonly position: number;
    readonly total: number;
    readonly label: string;
  } | null;
  /** True from the click on Stop until the run has ended, which waits for the request in flight. */
  readonly stopping: boolean;
}

/** The recording plan the Guide screen started, which outlives the screen while the person looks elsewhere. */
export interface GuidedPlan {
  readonly runId: string;
  /** `running` until the plan ends, then how it ended. */
  readonly state: PlanStatus["state"];
}

/** What the screens see of the diagnostic service. */
export interface DiagnosticsContextValue {
  readonly service: AppService;
  /** The open connection, or undefined when disconnected. */
  readonly connection: Connection | undefined;
  /** The profile the next connection is made with, or undefined for a generic OBD-II connection. */
  readonly profile: string | undefined;
  readonly setProfile: (profile: string | undefined) => void;
  /** Opens a connection from a click; rejects with a message fit to show. */
  readonly connect: (kind: AdapterKind, showAllBluetoothDevices: boolean) => Promise<void>;
  /** Stops any collection run, then closes the connection. */
  readonly disconnect: () => Promise<void>;
  readonly collection: CollectionView;
  /** Starts a run on the open connection, collecting the named values (by their `runs.values` names) or every supported value when none are given. */
  readonly startCollection: (signals?: readonly string[]) => Promise<void>;
  /** Stops the run being collected. */
  readonly stopCollection: () => Promise<void>;
  /** Collects again for an open run, from a click. */
  readonly resumeCollection: (run: Run) => Promise<void>;
  /** Bumps whenever a run starts, stops or resumes, so lists of runs reload. */
  readonly runsVersion: number;
  /** The plan the Guide screen started, until the person starts afresh. */
  readonly guided: GuidedPlan | undefined;
  /** Tracks a plan the service has started, or forgets the last one with `undefined`. */
  readonly trackPlan: (status: PlanStatus | undefined) => void;
  /** Runs of recording plans an earlier page left open, which the service stopped at start-up because a plan never resumes. */
  readonly interruptedPlans: readonly Run[];
  /** True the first time it is asked about `key` (a plan's run and phase pass), so a phase is announced once however often the Guide screen replays its events. */
  readonly isNewPhase: (key: string) => boolean;
}

const DiagnosticsContext = createContext<DiagnosticsContextValue | undefined>(undefined);

const IDLE: CollectionView = {
  run: undefined,
  state: undefined,
  lastError: null,
  latest: [],
  progress: null,
  stopping: false,
};

const STATUS_POLL_MS = 1000;

/** How often a collection run's status is read, so the value being requested keeps up with an adapter that answers a request a second; the read is local to the service. */
const COLLECTION_POLL_MS = 250;

/**
 * Gives the screens the service and tracks the connection and the collection run.
 *
 * A run left open by an earlier page (a reload) is resumed at once when it was collecting from the simulator, which needs no gesture. A run from hardware is only listed: reconnecting a device needs a click. A run another open tab is collecting or recording a plan into is never touched here: the tab working on a run holds its lock ({@link runClaims}). A run a recording plan left open is stopped first, never resumed, and listed in `interruptedPlans`.
 *
 * The screen is kept awake while a run collects or a plan runs.
 */
export function DiagnosticsProvider({
  service,
  children,
}: {
  readonly service: AppService;
  readonly children: ReactNode;
}) {
  const { client } = service;
  const [connection, setConnection] = useState<Connection | undefined>(undefined);
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [collection, setCollection] = useState<CollectionView>(IDLE);
  const [runsVersion, setRunsVersion] = useState(0);
  const [guided, setGuided] = useState<GuidedPlan | undefined>(undefined);
  const [interruptedPlans, setInterruptedPlans] = useState<readonly Run[]>([]);
  const runId = collection.run?.id;
  const resumed = useRef(false);
  const [claims] = useState(() =>
    runClaims(typeof navigator.locks === "object" ? navigator.locks : undefined),
  );
  const guidedRunning = guided?.state === "running" ? guided.runId : undefined;

  useWakeLock(runId !== undefined || guidedRunning !== undefined);
  useActivity("a collection run", runId !== undefined);
  useActivity("a recording plan", guidedRunning !== undefined);

  const announced = useRef(new Set<string>());
  const isNewPhase = useCallback((key: string) => {
    if (announced.current.has(key)) return false;
    announced.current.add(key);
    return true;
  }, []);

  const trackPlan = useCallback((status: PlanStatus | undefined) => {
    setGuided(status === undefined ? undefined : { runId: status.runId, state: status.state });
    setRunsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (guidedRunning === undefined) return;
    const live = { active: true };
    const timer = setInterval(() => {
      void client.plans.status({ runId: guidedRunning }).then((status) => {
        if (!live.active || status === null || status.state === "running") return;
        setGuided({ runId: status.runId, state: status.state });
        setRunsVersion((version) => version + 1);
      });
    }, STATUS_POLL_MS);
    return () => {
      live.active = false;
      clearInterval(timer);
    };
  }, [client, guidedRunning]);

  // Holds the run's lock for as long as this tab collects it or records a plan into it.
  useEffect(() => {
    const held = [runId, guidedRunning].filter((id) => id !== undefined);
    for (const id of held) void claims.claim(id);
    return () => {
      for (const id of held) claims.release(id);
    };
  }, [claims, runId, guidedRunning]);

  const track = useCallback((run: Run) => {
    setCollection({ ...IDLE, run, state: "collecting" });
    setRunsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void client.link.status().then((status) => {
      if (current) setConnection(status ?? undefined);
    });
    return () => {
      current = false;
    };
  }, [client]);

  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void (async () => {
      try {
        // Before the search for a run to resume, so a plan's run is never collected into; only
        // runs no other live tab holds, so a plan recording in another tab carries on.
        const unheld: string[] = [];
        for (const run of await client.runs.list({})) {
          if (run.stoppedAt === null && (await claims.claim(run.id))) unheld.push(run.id);
        }
        try {
          const stopped = await client.plans.recover({ runIds: unheld });
          if (stopped.length > 0) {
            setInterruptedPlans(stopped);
            setRunsVersion((version) => version + 1);
          }
        } finally {
          for (const id of unheld) claims.release(id);
        }
      } catch {
        // The runs stay open and listed; the next start-up tries again.
      }
      try {
        const open = (await client.runs.list({})).find(
          (run) => run.stoppedAt === null && isSimulatorUrl(run.adapter),
        );
        if (open === undefined || !(await claims.claim(open.id))) return;
        if ((await client.runs.status({ runId: open.id })) !== null) return;
        try {
          track(await client.runs.resume({ runId: open.id }));
        } catch (error) {
          claims.release(open.id);
          throw error;
        }
        setConnection((await client.link.status()) ?? undefined);
      } catch {
        // The run stays listed with its Resume button; there is nobody to tell at start-up.
      }
    })();
  }, [claims, client, track]);

  useEffect(() => {
    if (runId === undefined) return;
    const live = { active: true };
    const stream = client.live.samples({ runId });
    const latest = new Map<string, Sample>();
    void (async () => {
      try {
        for await (const sample of await stream) {
          if (!live.active) break;
          latest.set(sample.signal, sample);
          setCollection((view) => ({
            ...view,
            latest: [...latest.values()].sort((a, b) => a.signal.localeCompare(b.signal)),
          }));
        }
      } catch {
        // The stream ends when the run does; the status poll reports a failure.
      }
    })();
    const timer = setInterval(() => {
      void client.runs.status({ runId }).then((status) => {
        if (!live.active || status === null) return;
        setCollection((view) => ({
          ...view,
          state: status.state,
          lastError: status.lastError,
          progress: status.progress,
        }));
      });
    }, COLLECTION_POLL_MS);
    return () => {
      live.active = false;
      clearInterval(timer);
      void stream.then((iterator) => iterator.return());
    };
  }, [client, runId]);

  const connect = useCallback(
    async (kind: AdapterKind, showAll: boolean) => {
      const adapter = adapterUrl(kind, profile, showAll);
      // The picker needs the click's user activation, so it is the first await.
      if (kind === "webbluetooth") await service.devices.prepare(adapter);
      if (kind === "webserial") await client.adapters.grant(await service.devices.chooseSerial());
      setConnection(
        await client.link.connect({ ...(profile === undefined ? {} : { profile }), adapter }),
      );
    },
    [client, profile, service],
  );

  const stopCollection = useCallback(async () => {
    if (runId === undefined) return;
    // Said at once: the run ends after the request in flight, which an adapter can take a second to answer.
    setCollection((view) => ({ ...view, stopping: true }));
    try {
      await client.runs.stop({ runId });
    } catch (error) {
      setCollection((view) => ({ ...view, stopping: false }));
      throw error;
    }
    setCollection(IDLE);
    setRunsVersion((version) => version + 1);
  }, [client, runId]);

  const disconnect = useCallback(async () => {
    await stopCollection();
    await client.link.disconnect();
    setConnection(undefined);
  }, [client, stopCollection]);

  const startCollection = useCallback(
    async (signals?: readonly string[]) => {
      if (connection === undefined) throw new DiagnosticsError("Connect an adapter first.");
      track(
        await client.runs.start({
          ...(connection.profile === null ? {} : { profile: connection.profile }),
          adapter: connection.adapter,
          ...(signals === undefined || signals.length === 0 ? {} : { signals: [...signals] }),
        }),
      );
    },
    [client, connection, track],
  );

  const resumeCollection = useCallback(
    async (run: Run) => {
      if (run.adapter.startsWith("webbluetooth://")) await service.devices.prepare(run.adapter);
      if (!(await claims.claim(run.id))) throw collectedElsewhere();
      try {
        track(await client.runs.resume({ runId: run.id }));
      } catch (error) {
        claims.release(run.id);
        throw error;
      }
      setConnection((await client.link.status()) ?? undefined);
    },
    [claims, client, service, track],
  );

  const value = useMemo(
    () => ({
      service,
      connection,
      profile,
      setProfile,
      connect,
      disconnect,
      collection,
      startCollection,
      stopCollection,
      resumeCollection,
      runsVersion,
      guided,
      trackPlan,
      interruptedPlans,
      isNewPhase,
    }),
    [
      service,
      connection,
      profile,
      connect,
      disconnect,
      collection,
      startCollection,
      stopCollection,
      resumeCollection,
      runsVersion,
      guided,
      trackPlan,
      interruptedPlans,
      isNewPhase,
    ],
  );
  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

/** The diagnostic service and connection. Throws outside a {@link DiagnosticsProvider}. */
export function useDiagnostics(): DiagnosticsContextValue {
  const value = useContext(DiagnosticsContext);
  if (value === undefined) throw new Error("useDiagnostics needs a DiagnosticsProvider");
  return value;
}
