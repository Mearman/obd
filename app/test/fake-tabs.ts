import { MemoryStorage, type Storage } from "obd-read";
import { DATABASE_LOCK, holdDatabaseLock, type ExclusiveLocks } from "../src/database/exclusive";
import type { DatabaseConnection } from "../src/database/session";
import {
  readTabMessage,
  shareDatabase,
  type SharedDatabase,
  type TabChannel,
  type TabMessage,
} from "../src/database/tab-share";
import { fakeControl } from "./fake-database";

/**
 * A lock manager shared by every tab of one origin: a lock is held until its callback's promise settles or its owner is released, and requests that wait are granted in the order they were made, as the Web Locks API does.
 */
export class FakeLocks {
  private readonly holders = new Map<string, string>();
  private readonly queues = new Map<string, { owner: string; grant: () => void }[]>();

  /** The lock manager one tab's worker sees. */
  for(owner: string): ExclusiveLocks {
    return {
      request: (name, options, callback) => {
        if (!this.holders.has(name)) {
          this.holders.set(name, owner);
          return this.run(name, owner, callback);
        }
        if (options.ifAvailable === true) return callback(null);
        return new Promise<void>((resolve) => {
          const queue = this.queues.get(name) ?? [];
          queue.push({
            owner,
            grant: () => {
              void this.run(name, owner, callback).then(resolve);
            },
          });
          this.queues.set(name, queue);
        });
      },
    };
  }

  /** Runs a granted lock's callback and frees the lock once its promise settles. */
  private run(
    name: string,
    owner: string,
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void> {
    return callback({}).finally(() => {
      if (this.holders.get(name) === owner) this.free(name);
    });
  }

  /** Frees `name` and grants it to the next waiter. */
  private free(name: string): void {
    this.holders.delete(name);
    const next = this.queues.get(name)?.shift();
    if (next !== undefined) {
      this.holders.set(name, next.owner);
      next.grant();
    }
  }

  /** Takes `name` for an owner that never takes part in sharing, as a tab of an older version does. */
  hold(owner: string, name: string): void {
    this.holders.set(name, owner);
  }

  /** The owner holding `name`, if any. */
  holder(name: string): string | undefined {
    return this.holders.get(name);
  }

  /** Releases every lock `owner` holds and drops its queued requests, as the browser does when its worker ends, then grants each released lock to the next waiter. */
  release(owner: string): void {
    for (const [name, queue] of this.queues) {
      this.queues.set(
        name,
        queue.filter((waiter) => waiter.owner !== owner),
      );
    }
    for (const [name, holder] of [...this.holders]) {
      if (holder === owner) this.free(name);
    }
  }
}

/** Broadcast channels of one name: a message posted on one is structured-cloned and delivered asynchronously to every other open one, as `BroadcastChannel` does. */
export class FakeHub {
  private readonly open = new Set<{
    readonly listeners: Set<(event: { data: unknown }) => void>;
  }>();
  /** Every message posted, decoded, for assertions about the protocol. */
  readonly log: TabMessage[] = [];

  channel(): TabChannel & { cut(): void } {
    const end = { listeners: new Set<(event: { data: unknown }) => void>() };
    this.open.add(end);
    let closed = false;
    return {
      postMessage: (message) => {
        if (closed) throw new Error("InvalidStateError: the channel is closed");
        const data: unknown = structuredClone(message);
        const decoded = readTabMessage(data);
        if (decoded !== undefined) this.log.push(decoded);
        for (const other of this.open) {
          if (other === end) continue;
          queueMicrotask(() => {
            if (!this.open.has(other)) return;
            for (const listener of other.listeners) listener({ data });
          });
        }
      },
      addEventListener: (_type, listener) => {
        end.listeners.add(listener);
      },
      close: () => {
        closed = true;
        this.open.delete(end);
      },
      // A crashed tab: it neither sends nor receives again, without the close a live tab makes.
      cut: () => {
        closed = true;
        this.open.delete(end);
      },
    };
  }
}

/** Where a held call waits: before it touches the data, or after it changed it and before it answers. */
export type GatePlace = "before" | "after";

/**
 * The one database every tab shares, kept in memory. It allows one open connection at a time, as the `opfs-sahpool` VFS does, and records each connection and the calls it ran.
 */
export class FakeDatabase {
  readonly base = new MemoryStorage();
  readonly control = fakeControl();
  /** The owner of the open connection, if one is open. */
  openBy: string | undefined;
  /** Every owner that opened a connection, in order. */
  readonly openings: string[] = [];
  /** The calls each connection ran, as `owner:method`. */
  readonly ran: string[] = [];
  /** When set, calls of these methods wait at `place` until {@link releaseHeld}. */
  gate: { readonly methods: ReadonlySet<string>; readonly place: GatePlace } | undefined;
  private held: (() => void)[] = [];
  private readonly dead = new Set<string>();
  /** When set, opening fails with this error. */
  failure: Error | undefined;

  /** The number of calls waiting at the gate. */
  get waiting(): number {
    return this.held.length;
  }

  /** Lets every held call go on. */
  releaseHeld(): void {
    const held = this.held;
    this.held = [];
    for (const go of held) go();
  }

  open(owner: string): Promise<DatabaseConnection> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.openBy !== undefined) {
      return Promise.reject(new Error(`${owner} opened the database while ${this.openBy} has it`));
    }
    this.openBy = owner;
    this.openings.push(owner);
    const pass = async (method: string, work: () => Promise<unknown>): Promise<unknown> => {
      const gate = this.gate;
      const gated = gate?.methods.has(method) === true;
      if (gated && gate.place === "before") await this.wait();
      if (this.dead.has(owner)) return new Promise(() => undefined);
      this.ran.push(`${owner}:${method}`);
      const value = await work();
      if (gated && gate.place === "after") await this.wait();
      if (this.dead.has(owner)) return new Promise(() => undefined);
      return value;
    };
    const base = this.base;
    const storage = new Proxy<Storage>(base, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || typeof property !== "string") return value;
        return (...args: unknown[]) =>
          pass(property, async () => {
            const result: unknown = await Reflect.apply(value, target, args);
            return result;
          });
      },
    });
    return Promise.resolve({ storage, control: this.control });
  }

  /** Ends `owner`'s connection the way a closed tab does: nothing it was doing answers. */
  kill(owner: string): void {
    this.dead.add(owner);
    if (this.openBy === owner) this.openBy = undefined;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.held.push(resolve);
    });
  }
}

/** One tab of the app in a test. */
export interface FakeTab {
  readonly id: string;
  readonly shared: SharedDatabase;
  /** Ends the tab abruptly: its channel goes silent, its database connection stops answering and its lock passes on. */
  crash(): void;
}

/** The origin a test's tabs share: one lock manager, one broadcast channel name and one database. */
export class FakeOrigin {
  readonly locks = new FakeLocks();
  readonly hub = new FakeHub();
  readonly database = new FakeDatabase();

  constructor(private readonly answerLimit = 1_000) {}

  /** Opens a tab, which leads when nobody holds the lock and follows otherwise. */
  tab(id: string): FakeTab {
    const channel = this.hub.channel();
    const shared = shareDatabase({
      id,
      channel,
      lock: (queued) => holdDatabaseLock(this.locks.for(id), DATABASE_LOCK, queued),
      open: () => this.database.open(id),
      answerLimit: this.answerLimit,
    });
    return {
      id,
      shared,
      crash: () => {
        channel.cut();
        this.database.kill(id);
        this.locks.release(id);
      },
    };
  }
}

/** The connection a tab's screens would use. */
export async function storageOf(tab: FakeTab): Promise<Storage> {
  return (await tab.shared.connection).storage;
}
