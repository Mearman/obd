/**
 * The guard's snapshot store over {@link Storage}: a snapshot is a saved scan report.
 *
 * The guard names a snapshot with a string and needs to know it exists and what it says. Here a name maps to the scan report that `create` saved, so a snapshot survives a reload with the rest of the stored data and is listed beside scans. Names are held for the life of the object only; a new store knows none of an earlier one's.
 *
 * This module is platform-free.
 */

import { utf8Length } from "./bytes.js";
import { jsonSchema, StorageError, type Storage } from "./storage.js";
import type { WritableSnapshotStore } from "./writes.js";

/** What a snapshot's report records beside its content. */
export interface SnapshotContext {
  readonly profile: string;
  readonly adapter: string;
  /** The time the snapshot is taken, as storage records times. */
  readonly takenAt: number;
}

/** A snapshot that was saved: the name the guard knows it by and the stored report's id. */
export interface SavedSnapshot {
  readonly name: string;
  readonly id: string;
}

/** A {@link WritableSnapshotStore} that keeps each snapshot as a scan report in {@link Storage}. */
export class StorageSnapshotStore implements WritableSnapshotStore {
  private readonly ids = new Map<string, string>();

  constructor(
    private readonly storage: Storage,
    private readonly context: SnapshotContext,
  ) {}

  /** The snapshots created through this store, in the order created. */
  get saved(): readonly SavedSnapshot[] {
    return [...this.ids].map(([name, id]) => ({ name, id }));
  }

  async exists(snapshot: string): Promise<boolean> {
    const id = this.ids.get(snapshot);
    return id !== undefined && (await this.storage.getScanReport(id)) !== undefined;
  }

  async size(snapshot: string): Promise<number> {
    return utf8Length(await this.readText(snapshot));
  }

  async readText(snapshot: string): Promise<string> {
    const id = this.ids.get(snapshot);
    const report = id === undefined ? undefined : await this.storage.getScanReport(id);
    if (report === undefined) throw new StorageError("not-found", `no snapshot named ${snapshot}`);
    return JSON.stringify(report.report);
  }

  /**
   * Saves the snapshot's JSON text as a scan report labelled with its name.
   *
   * @throws StorageError `conflict` when the name is taken, `invalid` when the text is not JSON.
   */
  async create(snapshot: string, text: string): Promise<void> {
    if (this.ids.has(snapshot)) {
      throw new StorageError("conflict", `${snapshot} already exists`);
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new StorageError("invalid", `snapshot ${snapshot} is not JSON: ${String(error)}`);
    }
    const saved = await this.storage.saveScanReport({
      profile: this.context.profile,
      adapter: this.context.adapter,
      takenAt: this.context.takenAt,
      label: snapshot,
      report: jsonSchema.parse(document),
    });
    this.ids.set(snapshot, saved.id);
  }
}
