import type { Storage } from "obd-read";
import type { DatabaseControl } from "obd-read/web/storage";
import type { DatabaseSession } from "./session";

/** What an end-to-end build exposes on `window` so a browser test can drive the real database. */
export interface E2eDatabase {
  readonly storage: Storage;
  readonly control: DatabaseControl;
}

declare global {
  interface ImportMetaEnv {
    /** `"1"` in the build the end-to-end tests run on. */
    readonly VITE_OBD_E2E?: string;
  }

  interface Window {
    /** Set only in a build made with `VITE_OBD_E2E=1`; never present in the shipped app. */
    obdE2e?: Promise<E2eDatabase>;
  }
}

/** Publishes the session's connection as `window.obdE2e`. */
export function exposeForE2e(session: DatabaseSession): void {
  window.obdE2e = session.connection;
}
