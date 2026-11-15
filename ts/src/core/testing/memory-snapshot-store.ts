import type { SnapshotStore } from "../guard.js";

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // A surrogate pair is two UTF-16 units and four UTF-8 bytes, so each unit counts two.
    bytes += code < 0x80 ? 1 : code < 0x800 || (code >= 0xd800 && code < 0xe000) ? 2 : 3;
  }
  return bytes;
}

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
