/**
 * The clock and sleep the protocol layers use, declared here because the core type libraries
 * include neither `setTimeout` nor `performance`; both exist in every runtime core runs in.
 */

declare const setTimeout: (callback: () => void, milliseconds: number) => unknown;

/** The current time in milliseconds since the Unix epoch, for deadlines within one operation. */
export function now(): number {
  return Date.now();
}

/** Resolves after `milliseconds`. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
