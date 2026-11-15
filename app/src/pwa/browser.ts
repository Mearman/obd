import type { ReloadMemory, UpdateClock, UpdatePage, UpdateWorker } from "./updater";

/** The real clock. */
export const browserClock: UpdateClock = {
  now: () => Date.now(),
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    return () => {
      clearInterval(timer);
    };
  },
};

/** The page's visibility, network and service worker signals, and its reload. */
export function browserPage(): UpdatePage {
  return {
    online: () => navigator.onLine,
    onVisible(listener) {
      const onChange = (): void => {
        if (document.visibilityState === "visible") listener();
      };
      document.addEventListener("visibilitychange", onChange);
      return () => {
        document.removeEventListener("visibilitychange", onChange);
      };
    },
    onOnline(listener) {
      window.addEventListener("online", listener);
      return () => {
        window.removeEventListener("online", listener);
      };
    },
    onControllerChange(listener) {
      // Only attached once a registration exists, so the browser has service workers.
      const container = navigator.serviceWorker;
      container.addEventListener("controllerchange", listener);
      return () => {
        container.removeEventListener("controllerchange", listener);
      };
    },
    reload: () => {
      window.location.reload();
    },
  };
}

/** Where {@link sessionReloadMemory} keeps its version: per tab, surviving the reload. */
const RELOAD_KEY = "obd-read-reloaded-for";

/** The reload memory of this tab, in session storage. */
export function sessionReloadMemory(): ReloadMemory {
  return {
    read: () => sessionStorage.getItem(RELOAD_KEY) ?? undefined,
    write: (version) => {
      sessionStorage.setItem(RELOAD_KEY, version);
    },
  };
}

/**
 * The updater's view of a service worker registration.
 *
 * @param registration The registration vite-plugin-pwa reports in `onRegisteredSW`.
 * @param activate vite-plugin-pwa's `updateServiceWorker`, which tells the waiting worker to take over.
 */
export function registrationWorker(
  registration: ServiceWorkerRegistration,
  activate: () => Promise<void>,
): UpdateWorker {
  return {
    installing: () => registration.installing !== null,
    waiting: () => registration.waiting !== null,
    update: async () => {
      await registration.update();
    },
    activate,
  };
}
