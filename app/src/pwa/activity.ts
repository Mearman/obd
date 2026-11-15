/**
 * What is running in this tab that a reload would interrupt: a collection run, a scan, a save, an import or export. Each part of the app that starts such work marks it here while it runs, and the updater applies a new version only while nothing is marked.
 *
 * Any number of activities, of any names, can run at once; a name is only what the Settings screen shows as the reason an update waits.
 */
export interface ActivityRegistry {
  /**
   * Marks an activity as running.
   *
   * @param name What is running, in a few words a person can read.
   * @returns The function that marks it ended. Calling it more than once ends it once.
   */
  begin(name: string): () => void;
  /** The names of the activities running now, in the order they began, one entry per activity. Empty when the tab is idle. */
  running(): readonly string[];
  /** Calls `listener` after any activity begins or ends. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A registry with nothing running. */
export function createActivityRegistry(): ActivityRegistry {
  const active = new Map<symbol, string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    begin(name) {
      const token = Symbol(name);
      active.set(token, name);
      notify();
      return () => {
        if (active.delete(token)) notify();
      };
    },
    running: () => [...active.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Keeps an activity marked in `registry` for as long as a source reports itself busy.
 *
 * @param registry Where the activity is marked.
 * @param name What the source runs, as {@link ActivityRegistry.begin} takes it.
 * @param source Whether it is busy now, and the means to hear when that changes.
 * @returns The function that stops following the source and ends its activity.
 */
export function followActivity(
  registry: ActivityRegistry,
  name: string,
  source: { busy(): boolean; subscribeBusy(listener: () => void): () => void },
): () => void {
  let end: (() => void) | undefined;
  const sync = (): void => {
    if (source.busy() && end === undefined) end = registry.begin(name);
    else if (!source.busy() && end !== undefined) {
      end();
      end = undefined;
    }
  };
  const unsubscribe = source.subscribeBusy(sync);
  sync();
  return () => {
    unsubscribe();
    end?.();
    end = undefined;
  };
}
