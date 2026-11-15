import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { ActivityRegistry } from "./activity";

const ActivityContext = createContext<ActivityRegistry | undefined>(undefined);

/** Gives every part of the app the one {@link ActivityRegistry} the updater reads. */
export function ActivityProvider({
  registry,
  children,
}: {
  readonly registry: ActivityRegistry;
  readonly children: ReactNode;
}) {
  return <ActivityContext.Provider value={registry}>{children}</ActivityContext.Provider>;
}

/** The activity registry. Throws outside an {@link ActivityProvider}, so work is never marked where the updater cannot see it. */
export function useActivityRegistry(): ActivityRegistry {
  const registry = useContext(ActivityContext);
  if (registry === undefined) throw new Error("useActivityRegistry needs an ActivityProvider");
  return registry;
}

/**
 * Marks `name` as running for as long as `active` is true and the calling component is mounted, so an update waits for it.
 *
 * @param name What is running, as the Settings screen shows it.
 * @param active Whether it is running now.
 */
export function useActivity(name: string, active: boolean): void {
  const registry = useActivityRegistry();
  useEffect(() => (active ? registry.begin(name) : undefined), [registry, name, active]);
}
