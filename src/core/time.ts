/**
 * The clock and sleep the protocol layers use, declared here because the core type libraries
 * include neither `setTimeout` nor `performance`; both exist in every runtime core runs in.
 */

declare const setTimeout: (callback: () => void, milliseconds: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

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

/** The current UTC time as ISO 8601 with milliseconds and a `+00:00` offset, for log rows. */
export function isoNow(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

/** The current UTC time as ISO 8601 to the second with a `+00:00` offset, for saved documents. */
export function isoNowSeconds(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

/**
 * Calls `callback` once after `milliseconds` unless the returned function is called first.
 *
 * @returns A function that cancels the call; calling it after the callback has run does nothing.
 */
export function after(milliseconds: number, callback: () => void): () => void {
  const handle = setTimeout(callback, milliseconds);
  return () => {
    clearTimeout(handle);
  };
}
