import { isSimulatorUrl, type Connection, type Run, type Sample } from "obd-read";
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
import { useProfiles } from "../profiles/ProfilesProvider";
import { DiagnosticsError, type AdapterKind, type AppService } from "./client";
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
}

/** What the screens see of the diagnostic service. */
export interface DiagnosticsContextValue {
  readonly service: AppService;
  /** The open connection, or undefined when disconnected. */
  readonly connection: Connection | undefined;
  /** The profile the next connection is made with. */
  readonly profile: string;
  readonly setProfile: (profile: string) => void;
  /** Opens a connection from a click; rejects with a message fit to show. */
  readonly connect: (kind: AdapterKind, showAllBluetoothDevices: boolean) => Promise<void>;
  /** Stops any collection run, then closes the connection. */
  readonly disconnect: () => Promise<void>;
  readonly collection: CollectionView;
  /** Starts a run on the open connection. */
  readonly startCollection: () => Promise<void>;
  /** Stops the run being collected. */
  readonly stopCollection: () => Promise<void>;
  /** Collects again for an open run, from a click. */
  readonly resumeCollection: (run: Run) => Promise<void>;
  /** Bumps whenever a run starts, stops or resumes, so lists of runs reload. */
  readonly runsVersion: number;
}

const DiagnosticsContext = createContext<DiagnosticsContextValue | undefined>(undefined);

const IDLE: CollectionView = { run: undefined, state: undefined, lastError: null, latest: [] };

const STATUS_POLL_MS = 1000;

/**
 * Gives the screens the service and tracks the connection and the collection run.
 *
 * A run left open by an earlier page (a reload) is resumed at once when it was collecting from the simulator, which needs no gesture. A run from hardware is only listed: reconnecting a device needs a click.
 */
export function DiagnosticsProvider({
  service,
  children,
}: {
  readonly service: AppService;
  readonly children: ReactNode;
}) {
  const { client } = service;
  const { names } = useProfiles();
  const [connection, setConnection] = useState<Connection | undefined>(undefined);
  const [profile, setProfile] = useState(names[0] ?? "");
  const [collection, setCollection] = useState<CollectionView>(IDLE);
  const [runsVersion, setRunsVersion] = useState(0);
  const runId = collection.run?.id;
  const resumed = useRef(false);

  useWakeLock(runId !== undefined);

  const track = useCallback((run: Run) => {
    setCollection({ run, state: "collecting", lastError: null, latest: [] });
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
        const open = (await client.runs.list({})).find(
          (run) => run.stoppedAt === null && isSimulatorUrl(run.adapter),
        );
        if (open === undefined) return;
        if ((await client.runs.status({ runId: open.id })) === null) {
          track(await client.runs.resume({ runId: open.id }));
          setConnection((await client.link.status()) ?? undefined);
        }
      } catch {
        // The run stays listed with its Resume button; there is nobody to tell at start-up.
      }
    })();
  }, [client, track]);

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
        setCollection((view) => ({ ...view, state: status.state, lastError: status.lastError }));
      });
    }, STATUS_POLL_MS);
    return () => {
      live.active = false;
      clearInterval(timer);
      void stream.then((iterator) => iterator.return());
    };
  }, [client, runId]);

  const connect = useCallback(
    async (kind: AdapterKind, showAll: boolean) => {
      if (profile === "") throw new DiagnosticsError("Choose a vehicle profile first.");
      const adapter = adapterUrl(kind, profile, showAll);
      // The picker needs the click's user activation, so it is the first await.
      if (kind === "webbluetooth") await service.devices.prepare(adapter);
      if (kind === "webserial") await client.adapters.grant(await service.devices.chooseSerial());
      setConnection(await client.link.connect({ profile, adapter }));
    },
    [client, profile, service],
  );

  const stopCollection = useCallback(async () => {
    if (runId === undefined) return;
    await client.runs.stop({ runId });
    setCollection(IDLE);
    setRunsVersion((version) => version + 1);
  }, [client, runId]);

  const disconnect = useCallback(async () => {
    await stopCollection();
    await client.link.disconnect();
    setConnection(undefined);
  }, [client, stopCollection]);

  const startCollection = useCallback(async () => {
    if (connection === undefined) throw new DiagnosticsError("Connect an adapter first.");
    track(await client.runs.start({ profile: connection.profile, adapter: connection.adapter }));
  }, [client, connection, track]);

  const resumeCollection = useCallback(
    async (run: Run) => {
      if (run.adapter.startsWith("webbluetooth://")) await service.devices.prepare(run.adapter);
      track(await client.runs.resume({ runId: run.id }));
      setConnection((await client.link.status()) ?? undefined);
    },
    [client, service, track],
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
