import type { InflateResult, ShareCodec } from "../core/share.js";

/** Writes `bytes` into a transform stream, closes it and gathers what comes out, stopping once more than `maxBytes` has. */
async function through(
  stream: CompressionStream | DecompressionStream,
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
 * A {@link ShareCodec} over the web-standard `CompressionStream` and `DecompressionStream` (raw deflate), which browsers and Node both provide. Inflation is cancelled the moment its output passes the limit.
 */
export const streamShareCodec: ShareCodec = {
  async deflate(bytes: Uint8Array): Promise<Uint8Array> {
    const out = await through(
      new CompressionStream("deflate-raw"),
      new Uint8Array(bytes),
      Number.MAX_SAFE_INTEGER,
    );
    return joined(out.chunks, out.size);
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
