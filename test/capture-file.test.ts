import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CaptureError,
  MAX_CAPTURE_TEXT,
  captureFileBytes,
  compressCapture,
  importTranscript,
  readCaptureFile,
  type Capture,
} from "../src/core/index.js";

const FIXTURES = new URL("fixtures/", import.meta.url);

/** The two recorded A 150 transcripts as one imported capture. */
function a150(): Capture {
  const lines = ["a150-modes-01-to-09.txt", "a150-since-clear.txt"].flatMap((name) =>
    readFileSync(new URL(name, FIXTURES), "utf8").split("\n"),
  );
  return importTranscript(lines, { id: "a150", description: "recorded", profile: null }).capture;
}

describe("capture files", () => {
  it.each([
    ["JSON text", false],
    ["gzip", true],
  ])("round-trips as %s", (_label, compressed) => {
    const capture = a150();
    expect(readCaptureFile(captureFileBytes(capture, compressed), "a150")).toEqual(capture);
  });

  it("compresses the same capture to the same bytes", () => {
    expect(compressCapture(a150())).toEqual(compressCapture(a150()));
  });

  it("is much smaller compressed, measured on the recorded transcripts", () => {
    const capture = a150();
    const text = captureFileBytes(capture, false).length;
    const compressed = compressCapture(capture).length;
    // Measured on the recorded A 150 transcripts: the compressed form is about a tenth of the text.
    expect(compressed * 5).toBeLessThan(text);
  });

  it("refuses a gzip stream that inflates past the bound", () => {
    const bomb = gzipSync(new Uint8Array(MAX_CAPTURE_TEXT + 1), { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => readCaptureFile(bomb, "bomb.gz")).toThrow(
      `bomb.gz: inflates to more than the ${String(MAX_CAPTURE_TEXT)} bytes a capture may hold`,
    );
  });

  it.each([
    ["a truncated gzip stream", () => compressCapture(a150()).slice(0, 40)],
    [
      "a corrupt gzip stream",
      () => Uint8Array.of(0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff),
    ],
    ["gzip of something else", () => gzipSync(Buffer.from('{"tool":"obd-read"}'))],
    ["text that is not JSON", () => new TextEncoder().encode("hello")],
    ["an empty file", () => new Uint8Array(0)],
  ])("refuses %s", (_label, bytes) => {
    expect(() => readCaptureFile(bytes(), "hostile")).toThrow(CaptureError);
  });
});
