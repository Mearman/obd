import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DatabaseUnavailableError } from "obd-read/web/storage";
import type { DatabaseConnection, DatabaseSession } from "./session";

/** Why the database is not available: the two reasons the worker reports, or any other failure. */
export type DatabaseProblem = "in-use" | "unsupported" | "failed";

/** Where the database is: opening, ready to use, or unusable for a stated reason. */
export type DatabaseState =
  | { readonly status: "opening" }
  | ({ readonly status: "ready" } & DatabaseConnection)
  | { readonly status: "unavailable"; readonly problem: DatabaseProblem; readonly message: string };

/** What the screens see of the database. */
export interface DatabaseContextValue {
  readonly state: DatabaseState;
  /** Ends the current worker and starts a new one, for after the other tab was closed. */
  readonly retry: () => void;
  /** Changes after any tab of the app writes to the database, so a screen listing stored records reads them again. */
  readonly revision: number;
}

const DatabaseContext = createContext<DatabaseContextValue | undefined>(undefined);

/**
 * Gives the screens the database a worker opened, or the reason it could not.
 *
 * The first session is created by the caller, outside React, so StrictMode's repeated effects never start a second worker that would contend with the first. `start` creates the session a retry uses.
 */
export function DatabaseProvider({
  initial,
  start,
  children,
}: {
  readonly initial: DatabaseSession;
  readonly start: () => DatabaseSession;
  readonly children: ReactNode;
}) {
  const [session, setSession] = useState(initial);
  const [state, setState] = useState<DatabaseState>({ status: "opening" });
  const [revision, setRevision] = useState(0);

  useEffect(
    () =>
      session.subscribe(() => {
        setRevision((current) => current + 1);
      }),
    [session],
  );

  useEffect(() => {
    let current = true;
    session.connection.then(
      (connection) => {
        if (current) setState({ status: "ready", ...connection });
      },
      (error: unknown) => {
        if (!current) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({
          status: "unavailable",
          problem: error instanceof DatabaseUnavailableError ? error.reason : "failed",
          message,
        });
      },
    );
    return () => {
      current = false;
    };
  }, [session]);

  const retry = useCallback(() => {
    session.close();
    setState({ status: "opening" });
    setSession(start());
  }, [session, start]);

  const value = useMemo(() => ({ state, retry, revision }), [state, retry, revision]);
  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>;
}

/** The database state. Throws outside a {@link DatabaseProvider}. */
export function useDatabase(): DatabaseContextValue {
  const value = useContext(DatabaseContext);
  if (value === undefined) throw new Error("useDatabase needs a DatabaseProvider");
  return value;
}
