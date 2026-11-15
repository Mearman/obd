/** How long one round of the chosen values takes, from the adapter's measured time per request. */

/** The estimate as words, or a note that none can be made when `requestMs` is not a measurement. */
export function describeCycle(count: number, requestMs: number): string {
  if (count === 0) return "Choose at least one value.";
  const seconds = (count * requestMs) / 1000;
  const perRequest =
    requestMs < 100 ? `${String(Math.round(requestMs))} ms` : `${(requestMs / 1000).toFixed(1)} s`;
  const each = `${count === 1 ? "1 value" : `${String(count)} values`} at about ${perRequest} per request`;
  if (seconds < 1) return `A round of ${each} takes under a second.`;
  if (seconds < 60) return `A round of ${each} takes about ${String(Math.round(seconds))} s.`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `A round of ${each} takes about ${String(minutes)} min ${String(rest)} s.`;
}
