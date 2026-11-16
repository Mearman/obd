import { deflateRaw } from "pako";
import { SHARE_DEFLATE_LEVEL, type InflateResult, type ShareCodec } from "../core/share.js";

/** Writes `bytes` into a transform stream, closes it and gathers what comes out, stopping once more than `maxBytes` has. */
async function through(
  stream: DecompressionStream,
  bytes: Uint8Array<ArrayBuffer>,
  maxBytes: number,
): Promise<{ readonly chunks: Uint8Array[]; readonly size: number; readonly exceeded: boolean }> {
  const writer = stream.writable.getWriter();
  // A write or close that fails (truncated or invalid input) also fails the read below, which reports it.
  void writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { chunks, size, exceeded: false };
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      return { chunks, size, exceeded: true };
    }
    chunks.push(value);
  }
}

function joined(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A {@link ShareCodec} for the browser, which runs in Node too. It compresses with `pako`, a port of zlib, at {@link SHARE_DEFLATE_LEVEL}, because `CompressionStream` has no level and its default makes longer links than the CLI; the bytes are those `node:zlib` writes. It inflates through the web-standard `DecompressionStream` (raw deflate), cancelled the moment its output passes the limit.
 */
export const streamShareCodec: ShareCodec = {
  deflate(bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(deflateRaw(bytes, { level: SHARE_DEFLATE_LEVEL }));
  },

  async inflate(bytes: Uint8Array, maxBytes: number): Promise<InflateResult> {
    try {
      const out = await through(
        new DecompressionStream("deflate-raw"),
        new Uint8Array(bytes),
        maxBytes,
      );
      if (out.exceeded) return { ok: false, reason: "too-large" };
      return { ok: true, bytes: joined(out.chunks, out.size) };
    } catch {
      return { ok: false, reason: "corrupt" };
    }
  },
};
