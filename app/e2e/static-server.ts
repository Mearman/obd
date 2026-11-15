import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

/** A running static server and the origin it listens on. */
export interface StaticServer {
  /** The origin, such as `http://127.0.0.1:41234`, with no trailing slash. */
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Serves `directory` under `prefix` on a free localhost port, the way a GitHub Pages project site
 * serves a repository: a path outside the prefix and a path that names no file are both 404, and
 * a directory path serves its `index.html`. There is no single-page fallback, so a deep link only
 * works if the service worker answers it.
 *
 * @param directory The directory holding the build.
 * @param prefix The absolute path the build is served under, starting and ending with `/`.
 */
export async function serveUnderPrefix(directory: string, prefix: string): Promise<StaticServer> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      const relative = decodeURIComponent(pathname);
      if (!relative.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const target = normalize(join(directory, relative.slice(prefix.length)));
      if (target !== directory && !target.startsWith(directory + sep)) {
        response.writeHead(404).end();
        return;
      }
      const file = relative.endsWith("/") ? join(target, "index.html") : target;
      try {
        const body = await readFile(file);
        response
          .writeHead(200, {
            "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          })
          .end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  const { port }: AddressInfo = address;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
