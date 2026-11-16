import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_LINK_VERSION,
  MAX_BUNDLE_ITEMS,
  MAX_DECODED_BYTES,
  MAX_SERIES_POINTS,
  MAX_SIGNALS,
  PRACTICAL_LINK_LENGTH,
  SIMULATED_VIN,
  canonicalJson,
  captureShareData,
  decodeShare,
  decodeSharedLink,
  encodeShare,
  encodeShareBundle,
  obdReport,
  scan,
  shareBundleSchema,
  splitShareBundle,
  toBase64Url,
  FUNCTIONAL_ID,
  type ScanShareData,
  type ShareCodec,
  type ShareEnvelope,
} from "../src/core/index.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { streamShareCodec } from "../src/web/share-codec.js";
import { record, shipped } from "./helpers/captures.js";

const VIN = "TESTVAN0000000001";
const CREATED = 1_763_200_000_000;

function scanEnvelope(label: string): ShareEnvelope {
  const data: ScanShareData = {
    taken: "2026-11-15T10:00:00+00:00",
    profile: { name: "mercedes-w211" },
    adapter: { label },
    redacted: false,
    units: [
      {
        unit: "engine",
        description: "Engine control",
        request_id: "7E0",
        response_id: "7E8",
        answered: true,
        notes: [`read ${VIN} ok`],
        identification: {
          VIN: { hex: "544553545649", text: VIN },
          "serial number": { hex: "AABBCCDD", text: "SN-12345" },
        },
        faults: [{ code: "P0001", status: "2F" }],
        freeze_frames: {},
      },
    ],
  };
  return { v: 1, kind: "scan", createdAt: CREATED, data };
}

function runEnvelope(notes: string): ShareEnvelope {
  return {
    v: 1,
    kind: "run-summary",
    createdAt: CREATED,
    data: {
      run: { profile: "generic", adapter: "sim", startedAt: 1, stoppedAt: 2, notes },
      signals: [],
    },
  };
}

async function captureEnvelope(): Promise<ShareEnvelope> {
  const profile = shipped("vag-mqb");
  const capture = await record(profile, async (elm) => {
    await scan(elm, profile, { faults: true, freeze: false });
    await elm.addressFunctional(FUNCTIONAL_ID[11]);
    await obdReport(elm, () => undefined);
  });
  const data = captureShareData(capture);
  if (!data.ok) throw new Error(data.error.message);
  return { v: 1, kind: "capture", createdAt: CREATED, data: data.value };
}

const codecs: readonly (readonly [string, ShareCodec])[] = [
  ["zlib", zlibShareCodec],
  ["streams", streamShareCodec],
];

describe.each(codecs)("a bundle link through the %s codec", (_name, codec) => {
  it("decodes to exactly the results it was made from, in their order", async () => {
    const items = [scanEnvelope("first"), await captureEnvelope(), runEnvelope("third")];
    const encoded = await encodeShareBundle({ createdAt: CREATED, items }, codec);
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value.fragment).toMatch(new RegExp(`^share=${String(BUNDLE_LINK_VERSION)}\\.`));
    const decoded = await decodeSharedLink(encoded.value.fragment, codec);
    expect(decoded).toEqual({
      ok: true,
      value: { v: 1, kind: "bundle", createdAt: CREATED, redacted: false, items },
    });
  });

  it("applies one redaction choice to every result and records it", async () => {
    const items = [scanEnvelope("first"), await captureEnvelope()];
    const encoded = await encodeShareBundle({ createdAt: CREATED, items }, codec, {
      redactVin: true,
    });
    if (!encoded.ok) throw new Error(encoded.error.message);
    const decoded = await decodeSharedLink(encoded.value.fragment, codec);
    if (!decoded.ok || decoded.value.kind !== "bundle") throw new Error("not a bundle");
    expect(decoded.value.redacted).toBe(true);
    const text = JSON.stringify(decoded.value);
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(new TextDecoder().decode(SIMULATED_VIN));
    for (const item of decoded.value.items) {
      expect(item.kind === "scan" || item.kind === "capture").toBe(true);
      if (item.kind === "scan" || item.kind === "capture") expect(item.data.redacted).toBe(true);
    }
  });
});

describe("decodeSharedLink", () => {
  it("still reads a link of one result, unchanged", async () => {
    const envelope = scanEnvelope("alone");
    const encoded = await encodeShare(envelope, zlibShareCodec);
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value.fragment).toMatch(/^share=2\./);
    expect(await decodeSharedLink(encoded.value.fragment, zlibShareCodec)).toEqual({
      ok: true,
      value: envelope,
    });
    expect(await decodeShare(encoded.value.fragment, zlibShareCodec)).toEqual({
      ok: true,
      value: envelope,
    });
  });

  it("is refused by the one-result reader, which says what the link holds", async () => {
    const encoded = await encodeShareBundle(
      { createdAt: CREATED, items: [runEnvelope("a"), runEnvelope("b")] },
      zlibShareCodec,
    );
    if (!encoded.ok) throw new Error(encoded.error.message);
    const result = await decodeShare(encoded.value.fragment, zlibShareCodec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported-kind");
      expect(result.error.message).toMatch(/several results/);
    }
  });

  it("reports malformed bundle payloads as errors and never throws", async () => {
    const link = (bytes: Uint8Array): string =>
      `share=${String(BUNDLE_LINK_VERSION)}.${toBase64Url(new Uint8Array(deflateRawSync(bytes)))}`;
    const framed = (json: string, ...rest: number[]): Uint8Array => {
      const text = Buffer.from(json);
      if (text.length > 0x7f) throw new Error("test head too long");
      return Uint8Array.from([text.length, ...text, ...rest]);
    };
    const cases: readonly (readonly [string, Uint8Array, string])[] = [
      ["empty", new Uint8Array(0), "malformed"],
      ["head not JSON", framed("[nope"), "malformed"],
      ["unknown version", framed(`[2,${String(CREATED)},false,[]]`), "unsupported-version"],
      ["head of the wrong shape", framed('[1,"x"]'), "invalid"],
      ["no results", framed(`[1,${String(CREATED)},false,[]]`), "invalid"],
      ["lengths past the end", framed(`[1,${String(CREATED)},false,[5]]`, 0), "malformed"],
      ["bytes after the results", framed(`[1,${String(CREATED)},false,[1]]`, 0, 0), "malformed"],
      ["result not a payload", framed(`[1,${String(CREATED)},false,[1]]`, 0), "malformed"],
    ];
    for (const [label, bytes, code] of cases) {
      const result = await decodeSharedLink(link(bytes), zlibShareCodec);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.error.code, label).toBe(code);
    }
  });

  it("holds the whole bundle to the decoded limit", async () => {
    // Every signal at its most points: each result is within the limit and the bundle of them is not.
    const signals = Array.from({ length: MAX_SIGNALS }, (_, index) => ({
      signal: `signal ${String(index)}`,
      unit: "",
      count: MAX_SERIES_POINTS,
      numericCount: MAX_SERIES_POINTS,
      min: 0,
      max: 1,
      mean: 0.5,
      firstAt: 0,
      lastAt: MAX_SERIES_POINTS,
      series: Array.from({ length: MAX_SERIES_POINTS }, (_, at): [number, number] => [
        at * 1000,
        at / 7,
      ]),
    }));
    const big = runEnvelope("");
    if (big.kind !== "run-summary") throw new Error("not a run");
    const full: ShareEnvelope = { ...big, data: { ...big.data, signals } };
    const items = Array.from(
      { length: Math.ceil(MAX_DECODED_BYTES / canonicalJson(full).length) + 1 },
      () => full,
    );
    expect(canonicalJson(full).length).toBeLessThan(MAX_DECODED_BYTES);
    const encoded = await encodeShareBundle({ createdAt: CREATED, items }, zlibShareCodec);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error.code).toBe("too-large");
  });
});

describe("shareBundleSchema", () => {
  it("allows one to the most results, and refuses an unknown field", () => {
    const bundle = { v: 1, kind: "bundle", createdAt: CREATED, redacted: false };
    expect(shareBundleSchema.safeParse({ ...bundle, items: [] }).success).toBe(false);
    expect(shareBundleSchema.safeParse({ ...bundle, items: [runEnvelope("a")] }).success).toBe(
      true,
    );
    const most = Array.from({ length: MAX_BUNDLE_ITEMS + 1 }, () => runEnvelope("a"));
    expect(shareBundleSchema.safeParse({ ...bundle, items: most }).success).toBe(false);
    expect(
      shareBundleSchema.safeParse({ ...bundle, items: [runEnvelope("a")], extra: 1 }).success,
    ).toBe(false);
  });
});

describe("splitShareBundle", () => {
  /** Results that do not compress into each other: notes of random-looking text. */
  function distinct(count: number, length: number): ShareEnvelope[] {
    let state = 7;
    const next = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state;
    };
    return Array.from({ length: count }, () =>
      runEnvelope(Array.from({ length }, () => String.fromCharCode(97 + (next() % 26))).join("")),
    );
  }

  it("makes one link when the bundle fits", async () => {
    const items = distinct(3, 50);
    const parts = await splitShareBundle({ createdAt: CREATED, items }, zlibShareCodec, {
      maxLength: PRACTICAL_LINK_LENGTH,
    });
    if (!parts.ok) throw new Error(parts.error.message);
    expect(parts.value).toHaveLength(1);
    expect(parts.value[0]?.items).toEqual([0, 1, 2]);
  });

  it("splits into links each within the length, every result once and in order", async () => {
    const items = distinct(12, 600);
    const whole = await encodeShareBundle({ createdAt: CREATED, items }, zlibShareCodec);
    if (!whole.ok) throw new Error(whole.error.message);
    expect(whole.value.fragment.length).toBeGreaterThan(PRACTICAL_LINK_LENGTH);

    const parts = await splitShareBundle({ createdAt: CREATED, items }, zlibShareCodec, {
      maxLength: PRACTICAL_LINK_LENGTH,
    });
    if (!parts.ok) throw new Error(parts.error.message);
    expect(parts.value.length).toBeGreaterThan(1);
    expect(parts.value.flatMap((part) => part.items)).toEqual(items.map((_, index) => index));
    const read: ShareEnvelope[] = [];
    for (const part of parts.value) {
      expect(part.fragment.length).toBeLessThanOrEqual(PRACTICAL_LINK_LENGTH);
      const decoded = await decodeSharedLink(part.fragment, zlibShareCodec);
      if (!decoded.ok) throw new Error(decoded.error.message);
      // A part of one result is an ordinary link of one result.
      if (part.items.length === 1) expect(part.fragment).toMatch(/^share=2\./);
      read.push(...(decoded.value.kind === "bundle" ? decoded.value.items : [decoded.value]));
    }
    expect(canonicalJson(read)).toBe(canonicalJson(items));
  });

  it("gives a result too long for any link a link of its own, and says it is over", async () => {
    const items = [...distinct(1, 50), ...distinct(1, 4000), ...distinct(1, 50)];
    const parts = await splitShareBundle({ createdAt: CREATED, items }, zlibShareCodec, {
      maxLength: PRACTICAL_LINK_LENGTH,
    });
    if (!parts.ok) throw new Error(parts.error.message);
    expect(parts.value.map((part) => part.items)).toEqual([[0], [1], [2]]);
    expect(parts.value.map((part) => part.fragment.length > PRACTICAL_LINK_LENGTH)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
