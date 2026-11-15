/**
 * Test-only fault injection for the end-to-end build.
 *
 * It exists only in a build made with `VITE_OBD_E2E=1`: every use is behind that check, so the shipped bundle contains none of it. A browser test arms a fault with `window.obdE2eFail`, and the screen named renders a thrown error whose message the test chooses.
 */

import { useSyncExternalStore } from "react";
import type { ScreenId } from "./events";

/** What a test can make fail. */
export type E2eFault =
  | { readonly kind: "render"; readonly screen: ScreenId; readonly message: string }
  | { readonly kind: "window"; readonly message: string }
  | { readonly kind: "rejection"; readonly message: string }
  | { readonly kind: "clear" };

declare global {
  interface Window {
    /** Set only in a build made with `VITE_OBD_E2E=1`; never present in the shipped app. */
    obdE2eFail?: (fault: E2eFault) => void;
  }
}

let armed: { readonly screen: ScreenId; readonly message: string } | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function arm(next: typeof armed): void {
  armed = next;
  for (const listener of listeners) listener();
}

/** Installs `window.obdE2eFail`. */
export function installE2eFaults(): void {
  window.obdE2eFail = (fault) => {
    switch (fault.kind) {
      case "render":
        arm({ screen: fault.screen, message: fault.message });
        break;
      case "window":
        setTimeout(() => {
          throw new Error(fault.message);
        });
        break;
      case "rejection":
        void Promise.reject(new Error(fault.message));
        break;
      case "clear":
        arm(undefined);
        break;
    }
  };
}

/** Throws while a render fault is armed for `screen`. Renders nothing otherwise. */
export function E2eFaultPoint({ screen }: { readonly screen: ScreenId }) {
  const current = useSyncExternalStore(subscribe, () => armed);
  if (current?.screen === screen) throw new Error(current.message);
  return null;
}
