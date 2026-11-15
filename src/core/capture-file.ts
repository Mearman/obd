/**
 * A capture as a file: JSON text, or the same JSON compressed with gzip.
 *
 * The compressed form is what storage keeps and what `.obdcap.json.gz` files hold: the exchanges' hexadecimal and repeated keys compress well, about an eleventh of the JSON on the recorded A 150 transcripts. {@link readCaptureFile} tells the two apart by the gzip magic bytes, and inflates with a bound so a small hostile file cannot expand past {@link MAX_CAPTURE_TEXT}. This module is platform-free.
 */

import { Gunzip, gzipSync, strFromU8, strToU8 } from "fflate";
import {
  CaptureError,
  MAX_CAPTURE_TEXT,
  captureText,
  parseCapture,
  type Capture,
} from "./capture.js";

/** The two bytes every gzip stream starts with. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** The file name ending of a capture as JSON text. */
export const CAPTURE_JSON_SUFFIX = ".obdcap.json";

/** The file name ending of a compressed capture. */
export const CAPTURE_GZIP_SUFFIX = ".obdcap.json.gz";

/** Whether `bytes` start as a gzip stream does. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/**
 * The capture compressed: its compact JSON (no indentation) in gzip, with no file name and a zero time, so the same capture always gives the same bytes.
 */
export function compressCapture(capture: Capture): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(capture)), { level: 9, mtime: 0 });
}

/**
 * Inflates gzip bytes, refusing to produce more than `limit` bytes.
 *
 * @throws CaptureError when the stream is corrupt or would inflate past the limit.
 */
export function boundedGunzip(bytes: Uint8Array, limit: number, where: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // An object, so the check after the loop sees what the callback set.
  const stream = { ended: false };
  const inflater = new Gunzip((chunk, final) => {
    total += chunk.length;
    if (total > limit) {
      throw new CaptureError(
        `${where}: inflates to more than the ${String(limit)} bytes a capture may hold`,
      );
    }
    chunks.push(chunk);
    if (final) stream.ended = true;
  });
  const STEP = 64 * 1024;
  try {
    for (let offset = 0; offset < bytes.length; offset += STEP) {
      inflater.push(bytes.subarray(offset, offset + STEP), offset + STEP >= bytes.length);
    }
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(
      `${where}: not a readable gzip stream: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stream.ended) throw new CaptureError(`${where}: the gzip stream ends early`);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A capture from a file's bytes, compressed or not.
 *
 * @throws CaptureError when the file is not a capture, is larger than a capture may hold, or inflates past that.
 */
export function readCaptureFile(bytes: Uint8Array, where: string): Capture {
  if (isGzip(bytes)) {
    if (bytes.length > MAX_CAPTURE_TEXT) {
      throw new CaptureError(
        `${where}: ${String(bytes.length)} bytes is more than a capture may hold`,
      );
    }
    return parseCapture(strFromU8(boundedGunzip(bytes, MAX_CAPTURE_TEXT, where)), where);
  }
  if (bytes.length > MAX_CAPTURE_TEXT) {
    throw new CaptureError(
      `${where}: ${String(bytes.length)} bytes is more than the ${String(MAX_CAPTURE_TEXT)} a capture may hold`,
    );
  }
  return parseCapture(strFromU8(bytes), where);
}

/** The bytes of a capture file: JSON text, or compressed when `compressed` is true. */
export function captureFileBytes(capture: Capture, compressed: boolean): Uint8Array {
  return compressed ? compressCapture(capture) : strToU8(captureText(capture));
}
