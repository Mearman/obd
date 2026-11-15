import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { InflateResult, ShareCodec } from "../core/share.js";

/** Whether `error` is zlib refusing to produce more than `maxOutputLength` bytes. */
function isOutputLimit(error: unknown): boolean {
  return error instanceof RangeError && Reflect.get(error, "code") === "ERR_BUFFER_TOO_LARGE";
}

/**
 * A {@link ShareCodec} over `node:zlib` (raw deflate, the format the browser's `CompressionStream` writes). Inflation is bounded by zlib's own `maxOutputLength`, so a bomb is refused before it is held in memory.
 */
export const zlibShareCodec: ShareCodec = {
  deflate(bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(deflateRawSync(bytes, { level: 9 })));
  },

  inflate(bytes: Uint8Array, maxBytes: number): Promise<InflateResult> {
    try {
      return Promise.resolve({
        ok: true,
        bytes: new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxBytes })),
      });
    } catch (error) {
      return Promise.resolve({ ok: false, reason: isOutputLimit(error) ? "too-large" : "corrupt" });
    }
  },
};
