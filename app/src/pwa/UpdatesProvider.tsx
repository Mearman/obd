import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Updater, UpdateStatus } from "./updater";

const UpdatesContext = createContext<Updater | undefined>(undefined);

/** Gives the prompt and the Settings screen this tab's {@link Updater}. */
export function UpdatesProvider({
  updater,
  children,
}: {
  readonly updater: Updater;
  readonly children: ReactNode;
}) {
  return <UpdatesContext.Provider value={updater}>{children}</UpdatesContext.Provider>;
}

/** The updater and its current status. Throws outside an {@link UpdatesProvider}. */
export function useUpdates(): { readonly updater: Updater; readonly status: UpdateStatus } {
  const updater = useContext(UpdatesContext);
  if (updater === undefined) throw new Error("useUpdates needs an UpdatesProvider");
  const status = useSyncExternalStore(
    (listener) => updater.subscribe(listener),
    () => updater.status(),
  );
  return { updater, status };
}
