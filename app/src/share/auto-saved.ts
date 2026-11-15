const STORAGE_KEY = "obd-read.auto-saved-links";

/** How many digests are kept; the oldest go first. */
export const AUTO_SAVED_LIMIT = 100;

/**
 * The SHA-256 digest of a link's fragment as lower-case hex.
 *
 * The digest identifies the link text, not the content it carries: the same result shared twice is two different links, and both are saved. The record is kept in this browser's `localStorage`, so another browser or a cleared site is a fresh start. It only stops a reload, history navigation or opening the same link again from saving the same thing twice.
 */
export async function fragmentDigest(fragment: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fragment));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readDigests(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Whether a link with this digest was saved automatically here before. Unreadable storage reads as no. */
export function wasAutoSaved(digest: string): boolean {
  return readDigests().includes(digest);
}

/** Records a digest, keeping the newest {@link AUTO_SAVED_LIMIT}. A storage failure only loses the record. */
export function recordAutoSaved(digest: string): void {
  try {
    const kept = readDigests().filter((item) => item !== digest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...kept, digest].slice(-AUTO_SAVED_LIMIT)));
  } catch {
    // The record is a convenience, so the page works without it.
  }
}
