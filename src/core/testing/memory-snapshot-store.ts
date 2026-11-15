import { utf8Length } from "../bytes.js";
import type { SnapshotStore } from "../guard.js";

/** An in-memory {@link SnapshotStore} for tests: snapshots are strings in a map. */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly files = new Map<string, string>();

  /** Creates or replaces the snapshot `name`. */
  write(name: string, text: string): void {
    this.files.set(name, text);
  }

  /** Removes the snapshot `name`, if there is one. */
  remove(name: string): void {
    this.files.delete(name);
  }

  exists(snapshot: string): Promise<boolean> {
    return Promise.resolve(this.files.has(snapshot));
  }

  size(snapshot: string): Promise<number> {
    return this.text(snapshot).then(utf8Length);
  }

  readText(snapshot: string): Promise<string> {
    return this.text(snapshot);
  }

  private text(snapshot: string): Promise<string> {
    const text = this.files.get(snapshot);
    return text === undefined
      ? Promise.reject(new Error(`no snapshot named ${snapshot}`))
      : Promise.resolve(text);
  }
}
