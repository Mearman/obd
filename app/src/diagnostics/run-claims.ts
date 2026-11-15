import { DiagnosticsError } from "./client";
import type { ExclusiveLocks } from "../database/exclusive";

/** The Web Lock name a tab holds while its collector writes to a run. */
export function runLockName(runId: string): string {
  return `obd-read-run:${runId}`;
}

/**
 * Which runs this tab is collecting, as Web Locks other tabs can see.
 *
 * Every tab reads and writes the same runs, but a run's collector lives in the tab that started or resumed it. Each tab holds a run's lock while it collects that run, and the browser releases it when the tab goes away, so a tab never resumes a run another live tab is still collecting, and a reload resumes it once the old page is gone.
 */
export interface RunClaims {
  /** Takes the run's lock for this tab unless another tab holds it. Resolves true when this tab holds it, including when it already did. */
  claim(runId: string): Promise<boolean>;
  /** Lets the run's lock go; nothing happens when this tab does not hold it. */
  release(runId: string): void;
}

/**
 * Run claims over `locks`. Without a lock manager every claim succeeds: the database then cannot open (it needs Web Locks), so every tab keeps its own data in memory and no run is shared.
 */
export function runClaims(locks: ExclusiveLocks | undefined): RunClaims {
  const held = new Map<string, () => void>();
  const claiming = new Map<string, Promise<boolean>>();
  return {
    claim(runId) {
      if (locks === undefined || held.has(runId)) return Promise.resolve(true);
      const already = claiming.get(runId);
      if (already !== undefined) return already;
      const claim = new Promise<boolean>((resolve, reject) => {
        locks
          .request(runLockName(runId), { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(false);
              return Promise.resolve();
            }
            resolve(true);
            return new Promise<void>((release) => {
              held.set(runId, release);
            });
          })
          .catch(reject);
      }).finally(() => {
        claiming.delete(runId);
      });
      claiming.set(runId, claim);
      return claim;
    },
    release(runId) {
      held.get(runId)?.();
      held.delete(runId);
    },
  };
}

/** The refusal to resume a run another tab is collecting. */
export function collectedElsewhere(): DiagnosticsError {
  return new DiagnosticsError("This run is being collected in another tab or window of obd-read.");
}
