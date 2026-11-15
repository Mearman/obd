import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ConnectionInfo, ConnectRequest, DiagnosticsClient } from "./client";

/** What the screens see of the diagnostic service and the current connection. */
export interface DiagnosticsContextValue {
  readonly client: DiagnosticsClient;
  /** The open connection, or undefined when disconnected. */
  readonly connection: ConnectionInfo | undefined;
  /** Opens a connection; rejects as {@link DiagnosticsClient.connect} does. */
  readonly connect: (request: ConnectRequest) => Promise<void>;
  /** Closes the connection. */
  readonly disconnect: () => Promise<void>;
}

const DiagnosticsContext = createContext<DiagnosticsContextValue | undefined>(undefined);

/** Gives the screens one {@link DiagnosticsClient} and tracks whether it is connected. */
export function DiagnosticsProvider({
  client,
  children,
}: {
  readonly client: DiagnosticsClient;
  readonly children: ReactNode;
}) {
  const [connection, setConnection] = useState<ConnectionInfo | undefined>(undefined);

  const connect = useCallback(
    async (request: ConnectRequest) => {
      setConnection(await client.connect(request));
    },
    [client],
  );
  const disconnect = useCallback(async () => {
    await client.disconnect();
    setConnection(undefined);
  }, [client]);

  const value = useMemo(
    () => ({ client, connection, connect, disconnect }),
    [client, connection, connect, disconnect],
  );
  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

/** The diagnostic client and connection. Throws outside a {@link DiagnosticsProvider}. */
export function useDiagnostics(): DiagnosticsContextValue {
  const value = useContext(DiagnosticsContext);
  if (value === undefined) throw new Error("useDiagnostics needs a DiagnosticsProvider");
  return value;
}
