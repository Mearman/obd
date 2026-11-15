import { useEffect } from "react";

/**
 * Holds a screen wake lock while `active`, so the device does not sleep during a collection run.
 *
 * The browser drops the lock when the page is hidden, so it is requested again when the page becomes visible. Where the Screen Wake Lock API is missing, or the request is refused (a low battery, a hidden page), the run carries on without it: the lock is a convenience, not a requirement.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | undefined;
    let released = false;

    const acquire = async (): Promise<void> => {
      try {
        const next = await navigator.wakeLock.request("screen");
        if (released) await next.release();
        else sentinel = next;
      } catch {
        // Refused while hidden or on a low battery; the next visibility change tries again.
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && sentinel?.released !== false) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [active]);
}
