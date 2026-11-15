import { MemoryStorage } from "obd-read";
import { DatabaseUnavailableError, type DatabaseControl } from "obd-read/web/storage";
import type { DatabaseSession } from "../src/database/session";

/** A {@link DatabaseControl} that keeps one "file" in memory and records what it was asked. */
export function fakeControl(
  initial: Uint8Array = new TextEncoder().encode("SQLite format 3\0fake"),
): DatabaseControl & { file: Uint8Array } {
  const control = {
    file: initial,
    info: () =>
      Promise.resolve({
        sqliteVersion: "3.0.0",
        vfs: "fake-vfs",
        bytes: control.file.length,
        persisted: false,
      }),
    exportFile: () => Promise.resolve(control.file),
    importFile: (bytes: Uint8Array) => {
      if (bytes.length === 0)
        return Promise.reject(new Error("That file is not a SQLite database."));
      control.file = bytes;
      return Promise.resolve();
    },
  };
  return control;
}

/** A session whose database opens straight away on memory storage. */
export function readySession(control: DatabaseControl = fakeControl()): DatabaseSession {
  return {
    connection: Promise.resolve({ storage: new MemoryStorage(), control }),
    subscribe: () => () => undefined,
    busy: () => false,
    subscribeBusy: () => () => undefined,
    close: () => undefined,
  };
}

/** A session whose database cannot be used, as when a tab that cannot share holds it. */
export function unavailableSession(reason: "in-use" | "unsupported"): DatabaseSession {
  const connection = Promise.reject(new DatabaseUnavailableError(reason, `database ${reason}`));
  connection.catch(() => undefined);
  return {
    connection,
    subscribe: () => () => undefined,
    busy: () => false,
    subscribeBusy: () => () => undefined,
    close: () => undefined,
  };
}
