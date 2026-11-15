/**
 * Reads the public path the built app is served from, the one place the `BASE_PATH` environment
 * variable is consulted. Unset or empty it is `/`; otherwise it is the value with a leading and a
 * trailing slash, so `obd`, `/obd` and `/obd/` all give `/obd/`. Vite's `base`, the manifest's
 * `id`, `scope` and `start_url`, and the service worker's scope all derive from this value.
 *
 * @param environment The process environment to read `BASE_PATH` from.
 * @returns An absolute path that starts and ends with `/`.
 */
export function basePathFrom(environment: Readonly<Record<string, string | undefined>>): string {
  const segments = (environment.BASE_PATH ?? "").split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}
