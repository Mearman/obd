import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_ID,
  MAX_DECODED_BYTES,
  MAX_ENCODED_LENGTH,
  PRACTICAL_LINK_LENGTH,
  REDACTED_BYTE,
  SIMULATED_VIN,
  canonicalJson,
  captureIdentifyingValues,
  captureShareData,
  decodeCapture,
  decodeShare,
  encodeShare,
  importRecord,
  obdReport,
  redactCaptureShare,
  redactEnvelope,
  scan,
  shareContents,
  shareLink,
  type Capture,
  type CaptureShareData,
  type Exchange,
  type ShareEnvelope,
} from "../src/core/index.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { record, shipped } from "./helpers/captures.js";
import { RECORDED } from "./helpers/recorded-car.js";

const MQB = shipped("vag-mqb");
const VIN = new TextDecoder().decode(SIMULATED_VIN);
const PAGES = "https://mearman.github.io/obd/";

function hex(text: string): string {
  return Array.from(text, (character) =>
    character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
}

/** A UDS car scanned and read through the legislated services: its VIN is in a mode 09 reply and a UDS identification reply. */
async function simulatedCapture(): Promise<Capture> {
  return record(MQB, async (elm) => {
    await scan(elm, MQB, { faults: true, freeze: false });
    await elm.addressFunctional(FUNCTIONAL_ID[11]);
    await obdReport(elm, () => undefined);
  });
}

/** The two recorded A 150 transcripts imported as one capture. */
function recordedCapture(): Capture {
  const text = RECORDED.map((name) =>
    readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"),
  ).join("\n");
  return importRecord(text, "import-a150", "a150 transcripts").capture;
}

function shared(capture: Capture): CaptureShareData {
  const data = captureShareData(capture);
  if (!data.ok) throw new Error(data.error.message);
  return data.value;
}

function envelope(capture: Capture): ShareEnvelope {
  return { v: 1, kind: "capture", createdAt: 1_790_000_000_000, data: shared(capture) };
}

function messages(capture: Capture): string[] {
  return capture.exchanges.flatMap((exchange) =>
    exchange.outcome.kind === "replies"
      ? exchange.outcome.replies.flatMap((reply) => reply.messages)
      : [],
  );
}

async function roundTrip(sent: ShareEnvelope, redactVin: boolean) {
  const encoded = await encodeShare(sent, zlibShareCodec, { redactVin });
  if (!encoded.ok) throw new Error(encoded.error.message);
  const read = await decodeShare(encoded.value.fragment, zlibShareCodec);
  if (!read.ok) throw new Error(read.error.message);
  return { encoded: encoded.value, read: read.value };
}

describe("a capture share link", () => {
  it("carries the whole capture without the adapter's address and reads back equal", async () => {
    const capture = await simulatedCapture();
    expect(capture.sessions[0]?.adapter.url).toBe("simulator://test");
    const { read } = await roundTrip(envelope(capture), false);
    expect(read.kind).toBe("capture");
    if (read.kind !== "capture") return;
    expect(read.data.redacted).toBe(false);
    expect(read.data.capture.sessions[0]?.adapter.url).toBeNull();
    expect(read.data.capture).toEqual({
      ...capture,
      sessions: capture.sessions.map((session) => ({
        ...session,
        adapter: { ...session.adapter, url: null },
      })),
    });
  });

  it("decodes to the same reports after the round trip", async () => {
    const capture = await simulatedCapture();
    const { read } = await roundTrip(envelope(capture), false);
    if (read.kind !== "capture") throw new Error("not a capture");
    const target = { kind: "profile", profile: MQB } as const;
    expect(await decodeCapture(read.data.capture, target)).toEqual(
      await decodeCapture(capture, target),
    );
  });

  it("refuses an envelope whose capture names an adapter address", async () => {
    const capture = await simulatedCapture();
    const result = await encodeShare(
      { v: 1, kind: "capture", createdAt: 0, data: { redacted: false, capture } },
      zlibShareCodec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("adapter's address");
  });

  it("fits the recorded A 150 transcripts within the length every messenger keeps whole", async () => {
    const capture = recordedCapture();
    for (const redactVin of [false, true]) {
      const { encoded } = await roundTrip(envelope(capture), redactVin);
      const link = shareLink(PAGES, encoded.fragment);
      expect(encoded.decodedBytes).toBeLessThan(MAX_DECODED_BYTES);
      expect(encoded.fragment.length).toBeLessThan(MAX_ENCODED_LENGTH);
      // The two recorded visits make a link of about 1,650 characters under the Pages address.
      expect(link.length).toBeLessThan(PRACTICAL_LINK_LENGTH);
    }
  });
});

describe("redaction of a capture", () => {
  it("overwrites the VIN in the mode 09 and UDS identification replies, keeping each message's length", async () => {
    const capture = await simulatedCapture();
    const before = messages(capture);
    expect(before.some((message) => message.includes(hex(VIN)))).toBe(true);
    expect(captureIdentifyingValues(capture)).toContain(VIN);

    const redacted = redactCaptureShare(shared(capture));
    expect(redacted.redacted).toBe(true);
    const text = canonicalJson(redacted);
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(hex(VIN));
    expect(messages(redacted.capture).map((message) => message.length)).toEqual(
      before.map((message) => message.length),
    );
    expect(captureIdentifyingValues(redacted.capture)).toEqual([]);

    const decoded = await decodeCapture(redacted.capture, { kind: "profile", profile: MQB });
    expect(decoded.obd?.vin).toBe(String.fromCharCode(REDACTED_BYTE).repeat(VIN.length));
  });

  it("leaves every exchange that carries nothing identifying as it was", async () => {
    const capture = await simulatedCapture();
    const redacted = redactCaptureShare(shared(capture)).capture;
    const changed = capture.exchanges.filter(
      (exchange, index) => JSON.stringify(exchange) !== JSON.stringify(redacted.exchanges[index]),
    );
    expect(new Set(changed.map((exchange) => exchange.request))).toEqual(
      new Set(["0902", "22F190"]),
    );
  });

  it("overwrites the calibration identifier of the recorded A 150", () => {
    const capture = recordedCapture();
    const calibration = capture.exchanges.find((exchange) => exchange.request === "0904");
    expect(calibration?.outcome.kind).toBe("replies");
    const redacted = redactCaptureShare(shared(capture)).capture;
    const after = redacted.exchanges.find((exchange) => exchange.request === "0904");
    if (after?.outcome.kind !== "replies") throw new Error("no calibration reply");
    const [message] = after.outcome.replies[0]?.messages ?? [];
    expect(message?.slice(0, 6)).toBe("490401");
    expect(message?.slice(6)).toMatch(/^(?:2A)+$/);
  });

  it("overwrites every copy of the VIN, in another reply, a request, a note or an error text", async () => {
    const capture = await simulatedCapture();
    const last = capture.exchanges.at(-1);
    if (last === undefined) throw new Error("empty capture");
    const extra: Exchange[] = [
      {
        ...last,
        seq: last.seq + 1,
        request: "1A86",
        outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: [`5A86${hex(VIN)}00`] }] },
      },
      {
        ...last,
        seq: last.seq + 2,
        request: `2EF190${hex(VIN)}`,
        outcome: { kind: "no-response", message: `no answer from ${VIN}` },
      },
    ];
    const noisy: Capture = {
      ...capture,
      notes: [`read from ${VIN}`],
      exchanges: [...capture.exchanges, ...extra],
    };
    const text = canonicalJson(redactCaptureShare(shared(noisy)));
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(hex(VIN));
    expect(text).toContain(`5A86${"2A".repeat(VIN.length)}00`);
  });

  it("finds a VIN that only an unlabelled reply carries", () => {
    // The simulator's VIN has an I, which the VIN rule leaves out, so this one is shaped like a real VIN.
    const OTHER_VIN = "TESTVAN0000000001";
    const capture = recordedCapture();
    const last = capture.exchanges.at(-1);
    if (last === undefined) throw new Error("empty capture");
    expect(captureIdentifyingValues(capture)).not.toContain(OTHER_VIN);
    const block: Capture = {
      ...capture,
      exchanges: [
        ...capture.exchanges,
        {
          ...last,
          seq: last.seq + 1,
          request: "1A86",
          outcome: {
            kind: "replies",
            replies: [{ sender: 0x7e8, messages: [`5A86${hex(OTHER_VIN)}`] }],
          },
        },
      ],
    };
    expect(captureIdentifyingValues(block)).toContain(OTHER_VIN);
    expect(canonicalJson(redactCaptureShare(shared(block)))).not.toContain(hex(OTHER_VIN));
  });

  it("keeps the VIN when not asked to remove it, and removes it when asked", async () => {
    const capture = await simulatedCapture();
    const kept = await roundTrip(envelope(capture), false);
    expect(canonicalJson(kept.read)).toContain(hex(VIN));
    const removed = await roundTrip(envelope(capture), true);
    expect(canonicalJson(removed.read)).not.toContain(hex(VIN));
    expect(removed.read).toEqual(redactEnvelope(envelope(capture)));
  });
});

describe("what a capture link carries", () => {
  it("says whether the VIN is in it", async () => {
    const sent = envelope(await simulatedCapture());
    const included = shareContents(sent);
    expect(included.join("\n")).toMatch(/raw exchanges/);
    expect(included.join("\n")).toMatch(/included \(\d+ values?\)/);
    expect(included.join("\n")).toContain("Not included: the adapter's address.");
    expect(shareContents(redactEnvelope(sent)).join("\n")).toContain("overwritten with *");
  });
});
