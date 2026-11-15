/**
 * Keeps a long-lived tab on the newest release.
 *
 * Browsers look for a new service worker only on navigation and about once a day, so a tab left open would keep running old code, and an old tab cannot share the database with newer ones (`database/tab-share.ts`). The updater therefore asks the service worker registration to look for an update every {@link CHECK_INTERVAL_MS}, whenever the tab becomes visible and whenever the browser comes back online.
 *
 * A new version is applied only when it is safe: when no activity is marked in the {@link ActivityRegistry}. While anything runs the update waits, the prompt says a new version is ready, and the update applies as soon as the last activity ends. The person can always apply it at once with Reload.
 *
 * Tabs of the app tell each other which version they run over {@link VERSION_CHANNEL}: a tab announces its version when it starts and whenever it becomes visible, and a newer tab answers an older one. A tab that learns of a newer version looks for the update at once, and when no new service worker is waiting for it (the newer worker already took over elsewhere), it reloads onto the newer version once idle.
 */
import type { ActivityRegistry } from "./activity";
import { compareVersions } from "./version-order";

/** How often a tab asks for a new version without any other prompt: hourly, the interval vite-plugin-pwa's guide uses. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** The broadcast channel the tabs announce their versions on. Its messages never change shape, so tabs of every version can read each other. */
export const VERSION_CHANNEL = "obd-read-version";

/** A tab's version, sent when it starts or becomes visible (`ask`, which a newer tab answers) and in answer to an older tab. */
export interface VersionMessage {
  readonly kind: "version";
  readonly version: string;
  readonly ask: boolean;
}

/** Narrows a received message to a {@link VersionMessage}, or returns undefined for anything else. */
export function readVersionMessage(data: unknown): VersionMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("kind" in data) || data.kind !== "version") return undefined;
  if (!("version" in data) || typeof data.version !== "string") return undefined;
  if (!("ask" in data) || typeof data.ask !== "boolean") return undefined;
  return { kind: "version", version: data.version, ask: data.ask };
}

/** The part of a `BroadcastChannel` the updater uses, so a test can stand in for it. */
export interface VersionChannel {
  postMessage(message: VersionMessage): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}

/** The service worker registration, as the updater uses it. */
export interface UpdateWorker {
  /** Whether a new service worker is being installed now. */
  installing(): boolean;
  /** Whether a new service worker has installed and waits to take over. */
  waiting(): boolean;
  /** Asks the browser to fetch the service worker script and install it when it changed. Rejects when the script cannot be fetched. */
  update(): Promise<void>;
  /** Tells the waiting service worker to take over; the page reloads once it has ({@link Updater.controllerChanged}). */
  activate(): Promise<void>;
}

/** The page's signals and its reload. */
export interface UpdatePage {
  /** Whether the browser reports a network connection. */
  online(): boolean;
  /** Calls `listener` when the tab becomes visible. Returns the unsubscribe. */
  onVisible(listener: () => void): () => void;
  /** Calls `listener` when the browser comes back online. Returns the unsubscribe. */
  onOnline(listener: () => void): () => void;
  /** Calls `listener` when a new service worker takes control of the page. Returns the unsubscribe. */
  onControllerChange(listener: () => void): () => void;
  reload(): void;
}

/** The clock: the current time and a repeating timer. */
export interface UpdateClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Calls `callback` every `ms` milliseconds. Returns the function that stops it. */
  every(ms: number, callback: () => void): () => void;
}

/**
 * The version this tab last reloaded to reach because another tab ran it, kept across the reload. A tab that reloaded for a version and still runs an older one does not reload for that version again, so a newer tab served past the service worker can never send an older tab round a reload loop.
 */
export interface ReloadMemory {
  read(): string | undefined;
  write(version: string): void;
}

/** What {@link createUpdater} needs. */
export interface UpdaterOptions {
  /** The version this tab runs: `__APP_VERSION__`. */
  readonly version: string;
  readonly clock: UpdateClock;
  readonly page: UpdatePage;
  readonly activity: ActivityRegistry;
  readonly channel: VersionChannel;
  readonly memory: ReloadMemory;
}

/** Where updates stand in this tab, as the prompt and the Settings screen show it. */
export interface UpdateStatus {
  /** The version this tab runs. */
  readonly version: string;
  /** Whether a service worker registration is attached, without which nothing can be checked. */
  readonly supported: boolean;
  /** Whether a check is running. */
  readonly checking: boolean;
  /** When the last check that reached the server finished, in milliseconds since the epoch; undefined before the first. */
  readonly lastChecked: number | undefined;
  /** Why the last check failed, or undefined when it succeeded. */
  readonly problem: string | undefined;
  /** Whether a newer version is ready to load in this tab. */
  readonly ready: boolean;
  /** Whether the prompt is shown: an update is ready and the person has not dismissed it. */
  readonly prompt: boolean;
  /** The activities the update waits for, while it is ready; empty otherwise. */
  readonly waitingFor: readonly string[];
}

/** The updater of one tab. */
export interface Updater {
  status(): UpdateStatus;
  /** Calls `listener` after the status changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Starts checking through the service worker registration once it is registered. Later calls are ignored. */
  attach(worker: UpdateWorker): void;
  /** A new service worker is waiting; vite-plugin-pwa's `onNeedRefresh`. */
  waiting(): void;
  /** A new service worker took control of the page; vite-plugin-pwa's `onNeedReload`. */
  controllerChanged(): void;
  /** Checks for a new version now. Resolves when the check finished, whether it succeeded or not. */
  checkNow(): Promise<void>;
  /** Applies a ready update now, whatever is running: the person pressed Reload. */
  applyNow(): void;
  /** Hides the prompt. The update still applies on its own once nothing is running. */
  dismiss(): void;
  /** Calls `listener` with the version of every other tab that announces itself. Returns the unsubscribe. */
  onPeer(listener: (version: string) => void): () => void;
  /** Stops the timers and listeners and closes the channel. */
  dispose(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts the updater of this tab and announces its version to the other tabs; see the module comment. */
export function createUpdater(options: UpdaterOptions): Updater {
  const { version, clock, page, activity, channel, memory } = options;
  let worker: UpdateWorker | undefined;
  let checking: Promise<void> | undefined;
  let lastChecked: number | undefined;
  let problem: string | undefined;
  /** The newest version another tab announced, when newer than this one. */
  let newer: string | undefined;
  /** A new service worker is waiting. */
  let waitingWorker = false;
  /** A newer version runs elsewhere and no service worker waits for it here: a reload reaches it. */
  let stale = false;
  /** The waiting service worker was told to take over. */
  let activating = false;
  /** A new service worker controls the page, which still runs the old code. */
  let reloadPending = false;
  let reloading = false;
  /** The person pressed Reload, so the update applies whatever runs. */
  let forced = false;
  let dismissed = false;
  const listeners = new Set<() => void>();
  const peers = new Set<(version: string) => void>();
  const stops: (() => void)[] = [];

  const build = (): UpdateStatus => {
    const ready = waitingWorker || stale || reloadPending;
    return {
      version,
      supported: worker !== undefined,
      checking: checking !== undefined,
      lastChecked,
      problem,
      ready,
      prompt: ready && !dismissed,
      waitingFor: ready ? activity.running() : [],
    };
  };
  let snapshot = build();
  const emit = (): void => {
    snapshot = build();
    for (const listener of [...listeners]) listener();
  };

  const reload = (): void => {
    reloading = true;
    page.reload();
  };

  /** Applies whatever is ready, if nothing runs or the person asked; called after every change. */
  const evaluate = (): void => {
    if (reloading) return;
    const free = forced || activity.running().length === 0;
    if (!free) return;
    if (reloadPending) {
      reload();
      return;
    }
    if (waitingWorker) {
      if (activating || worker === undefined) return;
      activating = true;
      void worker.activate();
      return;
    }
    if (stale && newer !== undefined && (forced || memory.read() !== newer)) {
      memory.write(newer);
      reload();
    }
  };

  const check = (): Promise<void> => {
    if (checking !== undefined) return checking;
    const current = worker;
    if (current === undefined) return Promise.resolve();
    // As in vite-plugin-pwa's periodic-update guide: no check while a worker installs or the browser is offline.
    if (current.installing()) return Promise.resolve();
    if (!page.online()) {
      problem = "The browser is offline.";
      emit();
      return Promise.resolve();
    }
    checking = (async () => {
      try {
        await current.update();
        problem = undefined;
        lastChecked = clock.now();
        // The server answered and has no worker for this tab to wait for, so the newer version another tab runs is the one already in control: a reload reaches it.
        if (!current.waiting() && !current.installing() && newer !== undefined) stale = true;
      } catch (error) {
        problem = messageOf(error);
      }
      checking = undefined;
      if (current.waiting()) waitingWorker = true;
      emit();
      evaluate();
    })();
    emit();
    return checking;
  };

  const announce = (ask: boolean): void => {
    channel.postMessage({ kind: "version", version, ask });
  };

  channel.addEventListener("message", (event) => {
    const message = readVersionMessage(event.data);
    if (message === undefined) return;
    for (const peer of [...peers]) peer(message.version);
    const order = compareVersions(message.version, version);
    if (order === undefined) return;
    if (order > 0) {
      if (newer === undefined || (compareVersions(message.version, newer) ?? 0) > 0) {
        newer = message.version;
      }
      void check();
    } else if (order < 0 && message.ask) {
      announce(false);
    }
  });

  stops.push(
    activity.subscribe(() => {
      emit();
      evaluate();
    }),
  );
  announce(true);

  return {
    status: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(next) {
      if (worker !== undefined) return;
      worker = next;
      stops.push(
        clock.every(CHECK_INTERVAL_MS, () => void check()),
        page.onVisible(() => {
          announce(true);
          void check();
        }),
        page.onOnline(() => void check()),
        page.onControllerChange(() => {
          reloadPending = true;
          emit();
          evaluate();
        }),
      );
      emit();
      void check();
    },
    waiting() {
      waitingWorker = true;
      emit();
      evaluate();
    },
    controllerChanged() {
      reloadPending = true;
      emit();
      evaluate();
    },
    checkNow: check,
    applyNow() {
      forced = true;
      evaluate();
    },
    dismiss() {
      dismissed = true;
      emit();
    },
    onPeer(listener) {
      peers.add(listener);
      return () => {
        peers.delete(listener);
      };
    },
    dispose() {
      for (const stop of stops.splice(0)) stop();
      channel.close();
    },
  };
}
