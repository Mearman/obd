/**
 * What a report reads from the running page: build, browser, capability flags and the values to scrub.
 *
 * The browser's user agent string is read here and reduced to a family and a major version by the report builder; it is never stored or shown whole.
 */

import { capabilities } from "obd-read/web";
import { APP_VERSION } from "../release/release";
import type { ScrubContext } from "./anonymise";
import type { ReportEnvironment } from "./report";
import type { ServiceWorkerState, StorageState } from "./events";

declare global {
  interface ImportMetaEnv {
    /** The commit the app was built from, set by the build. */
    readonly VITE_OBD_BUILD?: string;
  }
}

/** The version and build the running app was made from, or `unknown` for a run that has no build (a test). */
export function readBuild(env: Pick<ImportMetaEnv, "VITE_OBD_BUILD">): {
  readonly version: string;
  readonly build: string;
} {
  return { version: APP_VERSION, build: env.VITE_OBD_BUILD ?? "unknown" };
}

let storageState: StorageState = "opening";
const known = new Set<string>();

/** Sets the database state a report names. */
export function setStorageState(state: StorageState): void {
  storageState = state;
}

/** Adds values (an adapter's name, its address) that must never appear in a report, wherever they would. */
export function registerSensitive(values: readonly (string | null | undefined)[]): void {
  for (const value of values)
    if (value !== null && value !== undefined && value !== "") known.add(value);
}

/** Forgets every registered value; for tests. */
export function clearSensitive(): void {
  known.clear();
}

function serviceWorkerState(): ServiceWorkerState {
  if (!("serviceWorker" in navigator)) return "unsupported";
  return navigator.serviceWorker.controller === null ? "uncontrolled" : "controlled";
}

/** The page's environment, read now. */
export function readEnvironment(): ReportEnvironment {
  const support = capabilities();
  return {
    ...readBuild(import.meta.env),
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    flags: {
      webSerial: support.webSerial,
      webBluetooth: support.webBluetooth,
      webUsb: support.webUsb,
      secureContext: support.secureContext,
      standalone: window.matchMedia("(display-mode: standalone)").matches,
      opfs: "storage" in navigator && "getDirectory" in navigator.storage,
      serviceWorker: serviceWorkerState(),
      storage: storageState,
    },
  };
}

/** What the scrubbers need about this page. */
export function readScrubContext(): ScrubContext {
  return {
    appOrigin: window.location.origin,
    basePath: import.meta.env.BASE_URL,
    known: [...known],
  };
}
