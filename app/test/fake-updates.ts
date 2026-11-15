import { vi } from "vitest";
import { createActivityRegistry, type ActivityRegistry } from "../src/pwa/activity";
import {
  createUpdater,
  type ReloadMemory,
  type UpdateClock,
  type UpdatePage,
  type Updater,
  type UpdateWorker,
  type VersionChannel,
  type VersionMessage,
} from "../src/pwa/updater";

/** Broadcast channels of one origin: what one tab posts, every other tab's channel receives, asynchronously as browsers deliver it. */
export class FakeBroadcast {
  private readonly members = new Set<(data: unknown) => void>();

  /** The channel one tab opens. */
  open(): VersionChannel & { readonly sent: VersionMessage[] } {
    const listeners = new Set<(event: { readonly data: unknown }) => void>();
    const receive = (data: unknown): void => {
      for (const listener of listeners) listener({ data });
    };
    this.members.add(receive);
    const sent: VersionMessage[] = [];
    return {
      sent,
      postMessage: (message) => {
        sent.push(message);
        for (const member of this.members) {
          if (member !== receive)
            queueMicrotask(() => {
              member(message);
            });
        }
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      close: () => {
        this.members.delete(receive);
      },
    };
  }
}

/** A page whose signals a test fires by hand, counting its reloads. */
export interface FakePage extends UpdatePage {
  visible(): void;
  comeOnline(): void;
  controllerChange(): void;
  isOnline: boolean;
  readonly reloads: () => number;
}

export function fakePage(): FakePage {
  const visible = new Set<() => void>();
  const online = new Set<() => void>();
  const controller = new Set<() => void>();
  let reloads = 0;
  const subscribe = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const page: FakePage = {
    isOnline: true,
    online: () => page.isOnline,
    onVisible: subscribe(visible),
    onOnline: subscribe(online),
    onControllerChange: subscribe(controller),
    reload: () => {
      reloads += 1;
    },
    visible: () => {
      for (const listener of visible) listener();
    },
    comeOnline: () => {
      for (const listener of online) listener();
    },
    controllerChange: () => {
      for (const listener of controller) listener();
    },
    reloads: () => reloads,
  };
  return page;
}

/** A service worker registration: `deploy` makes the next update find a new worker, which then waits; `activate` hands control to it through the page. */
export interface FakeWorker extends UpdateWorker {
  readonly update: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly activate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  deploy(): void;
  isWaiting: boolean;
}

export function fakeWorker(page: FakePage): FakeWorker {
  let deployed = false;
  const worker: FakeWorker = {
    isWaiting: false,
    installing: () => false,
    waiting: () => worker.isWaiting,
    update: vi.fn(() => {
      if (deployed) worker.isWaiting = true;
      return Promise.resolve();
    }),
    activate: vi.fn(() => {
      worker.isWaiting = false;
      page.controllerChange();
      return Promise.resolve();
    }),
    deploy: () => {
      deployed = true;
    },
  };
  return worker;
}

/** Reload memory of one tab, kept in a variable. */
export function fakeMemory(): ReloadMemory {
  let stored: string | undefined;
  return {
    read: () => stored,
    write: (version) => {
      stored = version;
    },
  };
}

/** A clock on vitest's timers, so `vi.advanceTimersByTime` drives it. */
export const timerClock: UpdateClock = {
  now: () => Date.now(),
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    return () => {
      clearInterval(timer);
    };
  },
};

/** One tab's updater over fakes. */
export interface FakeTab {
  readonly updater: Updater;
  readonly activity: ActivityRegistry;
  readonly page: FakePage;
  readonly worker: FakeWorker;
  readonly channel: ReturnType<FakeBroadcast["open"]>;
}

/** Opens a tab running `version` on `broadcast`; its updater is attached to a fake registration unless `attach` is false, and remembers reloads in `memory`. */
export function openFakeTab(
  version: string,
  broadcast = new FakeBroadcast(),
  attach = true,
  memory: ReloadMemory = fakeMemory(),
): FakeTab {
  const page = fakePage();
  const worker = fakeWorker(page);
  const activity = createActivityRegistry();
  const channel = broadcast.open();
  const updater = createUpdater({
    version,
    clock: timerClock,
    page,
    activity,
    channel,
    memory,
  });
  if (attach) updater.attach(worker);
  return { updater, activity, page, worker, channel };
}
