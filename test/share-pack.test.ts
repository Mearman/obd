import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_ID,
  MAX_DECODED_BYTES,
  MAX_ENCODED_LENGTH,
  PRACTICAL_LINK_LENGTH,
  SIMULATED_VIN,
  canonicalJson,
  captureShareData,
  captureText,
  decodeShare,
  describeLinkLength,
  encodeShare,
  fromBase64Url,
  obdReport,
  packedSharePayload,
  scan,
  sweep,
  toBase64Url,
  type Capture,
  type Exchange,
  type ShareCodec,
  type ShareEnvelope,
} from "../src/core/index.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { streamShareCodec } from "../src/web/share-codec.js";
import { record, shipped } from "./helpers/captures.js";

const VIN = new TextDecoder().decode(SIMULATED_VIN);
const W211 = shipped("mercedes-w211");
const MQB = shipped("vag-mqb");

/** A seeded generator of numbers in [0, 1) (mulberry32), so every random case is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function envelopeOf(capture: Capture, createdAt = capture.endedAt): ShareEnvelope {
  const data = captureShareData(capture);
  if (!data.ok) throw new Error(data.error.message);
  return { v: 1, kind: "capture", createdAt, data: data.value };
}

/** The capture `capture` becomes once shared: the same but with no adapter address. */
function sharedCopy(capture: Capture): Capture {
  return {
    ...capture,
    sessions: capture.sessions.map((session) => ({
      ...session,
      adapter: { ...session.adapter, url: null },
    })),
  };
}

async function fragmentOf(
  envelope: ShareEnvelope,
  codec: ShareCodec = zlibShareCodec,
  redactVin = false,
): Promise<string> {
  const result = await encodeShare(envelope, codec, { redactVin });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.fragment;
}

/** Encodes and decodes `capture`, expecting the very capture back: equal, the same canonical JSON and the same capture file text. */
async function expectRoundTrip(capture: Capture, codec: ShareCodec, label: string): Promise<void> {
  const envelope = envelopeOf(capture);
  const fragment = await fragmentOf(envelope, codec);
  expect(fragment, label).toMatch(/^share=2\./);
  const result = await decodeShare(fragment, codec);
  expect(result, label).toEqual({ ok: true, value: envelope });
  if (!result.ok || result.value.kind !== "capture") throw new Error(label);
  expect(canonicalJson(result.value), label).toBe(canonicalJson(envelope));
  expect(captureText(result.value.data.capture), label).toBe(captureText(sharedCopy(capture)));
}

/** A capture's exchanges given times that move on by a jittered gap, as a real recording's do. */
function timed(capture: Capture, seed: number): Capture {
  const next = random(seed);
  let at = capture.startedAt;
  const exchanges = capture.exchanges.map((exchange) => {
    at += 1000 + Math.floor(next() * 300);
    return { ...exchange, at };
  });
  return { ...capture, exchanges, endedAt: at };
}

const SESSION = {
  adapter: {
    url: null,
    identity: "ELM327 v1.5",
    description: null,
    stnIdentity: null,
    voltage: "12.4V",
    hasStnExtensions: false,
  },
  tool: { name: "obd-read", version: "test" },
};

const CAN = { kind: "can", idBits: 11, bitrate: 500_000 } as const;

/** The upper-case hexadecimal of ASCII text, as a reply spells it. */
function hexOfText(text: string): string {
  return Buffer.from(text, "ascii").toString("hex").toUpperCase();
}

function exchange(seq: number, fields: Partial<Exchange> = {}): Exchange {
  return {
    seq,
    at: 1_000_000 + seq * 1215,
    session: 0,
    bus: CAN,
    address: { mode: "functional", requestId: 0x7df },
    protocol: "obd",
    request: "0100",
    outcome: { kind: "replies", replies: [{ sender: 0x7e8, messages: ["4100BE3EB813"] }] },
    ...fields,
  };
}

function handBuilt(exchanges: readonly Exchange[], fields: Partial<Capture> = {}): Capture {
  return {
    format: "obd-read-capture",
    version: 1,
    id: "capture-hand-built",
    startedAt: 1_000_000,
    endedAt: 2_000_000,
    origin: { kind: "capture", profile: null, complete: true, description: "hand built" },
    sessions: [SESSION],
    exchanges: [...exchanges],
    notes: [],
    ...fields,
  };
}

/** Hand-built captures covering every field's forms. */
function edgeCases(): readonly (readonly [string, Capture])[] {
  return [
    ["empty", handBuilt([])],
    ["single exchange", handBuilt([exchange(0)])],
    [
      "adapter and transport errors",
      handBuilt([
        exchange(0, {
          outcome: { kind: "adapter-error", error: "ElmError", message: "BUS INIT: ...ERROR" },
        }),
        exchange(1, {
          outcome: { kind: "adapter-error", error: "AdapterUnsupported", message: "?" },
        }),
        exchange(2, {
          outcome: { kind: "transport-error", error: "TransportError", message: "closed" },
        }),
        exchange(3, {
          outcome: { kind: "transport-error", error: "TransportTimeout", message: "" },
        }),
        exchange(4, { outcome: { kind: "no-response", message: "NO DATA" } }),
        exchange(5, { outcome: { kind: "no-response", message: "NO DATA" } }),
      ]),
    ],
    [
      "multi-frame, several senders and messages, negative and empty replies",
      handBuilt([
        exchange(0, {
          request: "0902",
          outcome: {
            kind: "replies",
            replies: [
              { sender: 0x7e8, messages: [`490201${hexOfText("WDB2110200A000000")}`] },
              { sender: 0x7e9, messages: ["7F0978", "490201", ""] },
            ],
          },
        }),
        exchange(1, {
          request: "22F190",
          address: { mode: "physical", requestId: 0x7e0, responseId: 0x7e8, extendedAddress: null },
          protocol: "uds",
          outcome: {
            kind: "replies",
            replies: [{ sender: 0x7e8, messages: ["62F190", "7F2231", "06", "62"] }],
          },
        }),
        exchange(2, {
          request: "3F",
          outcome: {
            kind: "replies",
            replies: [{ sender: 0, messages: ["7F", "7F3F", "7F3F00"] }],
          },
        }),
        exchange(3, {
          request: "FF00",
          outcome: {
            kind: "replies",
            replies: [{ sender: 0x1fffffff, messages: ["FF00", "3F00"] }],
          },
        }),
      ]),
    ],
    [
      "every bus and address form, no protocol and sequence gaps",
      handBuilt(
        [
          exchange(0, { bus: null, address: null, protocol: null }),
          exchange(3, { address: { mode: "functional", requestId: null } }),
          exchange(4, {
            bus: { kind: "can", idBits: 29, bitrate: null },
            address: {
              mode: "physical",
              requestId: 0x18da10f1,
              responseId: null,
              extendedAddress: 0x12,
            },
            outcome: { kind: "replies", replies: [{ sender: 0x18daf110, messages: ["4100"] }] },
          }),
          exchange(9, {
            bus: { kind: "kline", scheme: "kwp2000-fast", tester: 0xf1, headerFormat: 0xc0 },
            address: { mode: "physical", requestId: 0x33, responseId: 0x10, extendedAddress: 0 },
            protocol: "kwp2000",
            request: "1081",
            outcome: { kind: "replies", replies: [{ sender: 0x10, messages: ["5081"] }] },
          }),
          exchange(10, { address: { mode: "any-reply", requestId: 0 }, session: 1 }),
          exchange(1000, {
            address: { mode: "physical", requestId: 5, responseId: 4, extendedAddress: null },
          }),
        ],
        { sessions: [SESSION, { ...SESSION, tool: { name: "other", version: "2" } }] },
      ),
    ],
    [
      "times out of order, equal, far apart and at the epoch",
      handBuilt(
        [
          exchange(0, { at: 0 }),
          exchange(1, { at: 0 }),
          exchange(2, { at: Number.MAX_SAFE_INTEGER }),
          exchange(3, { at: 5 }),
          exchange(4, { at: 127 }),
          exchange(5, { at: 128 }),
        ],
        { startedAt: 0, endedAt: Number.MAX_SAFE_INTEGER },
      ),
    ],
    [
      "incomplete, with notes and unicode in every text",
      handBuilt(
        [
          exchange(0, { outcome: { kind: "no-response", message: "keine Antwort é \u{1F697}" } }),
          exchange(1, {
            outcome: { kind: "adapter-error", error: "ElmError", message: "\ud800 lone \u0000  " },
          }),
        ],
        {
          origin: {
            kind: "import",
            profile: "mercedes-w211",
            complete: false,
            description: "Zündung an, “quotes” \u{1F527}",
          },
          notes: ["first note", "naïve café", "\udfff", ""],
          sessions: [
            {
              ...SESSION,
              adapter: {
                ...SESSION.adapter,
                identity: "ELM327 v2.1 ✓",
                description: "Ω",
                stnIdentity: "STN2120",
                voltage: null,
                hasStnExtensions: null,
              },
            },
          ],
        },
      ),
    ],
  ];
}

/** A capture of random exchanges, every field drawn from its whole range of forms. */
function randomCapture(seed: number): Capture {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error("empty choice");
    return item;
  };
  const bytes = (most: number): string =>
    Array.from({ length: Math.floor(next() * (most + 1)) }, () =>
      Math.floor(next() * 256)
        .toString(16)
        .toUpperCase()
        .padStart(2, "0"),
    ).join("");
  const id = (): number =>
    pick([0x7df, 0x7e0, 0x7e8, Math.floor(next() * 0x800), Math.floor(next() * 0x20000000)]);
  let seq = -1;
  let at = 1_700_000_000_000;
  const exchanges: Exchange[] = Array.from({ length: Math.floor(next() * 40) }, () => {
    seq += 1 + (next() < 0.2 ? Math.floor(next() * 5) : 0);
    at += Math.floor(next() * 3000) - (next() < 0.1 ? 5000 : 0);
    const request = `${pick(["01", "09", "22", "1A", "10", "3E", "FF"])}${bytes(3)}`;
    const address: Exchange["address"] = pick([
      null,
      { mode: "functional", requestId: null },
      { mode: "functional", requestId: id() },
      {
        mode: "physical",
        requestId: id(),
        responseId: next() < 0.5 ? null : id(),
        extendedAddress: next() < 0.5 ? null : Math.floor(next() * 256),
      },
      { mode: "any-reply", requestId: id() },
    ]);
    const service = Number.parseInt(request.slice(0, 2), 16);
    const message = (): string =>
      pick([
        bytes(12),
        service + 0x40 > 0xff
          ? bytes(4)
          : `${(service + 0x40).toString(16).toUpperCase()}${request.slice(2)}${bytes(6)}`,
        `7F${request.slice(0, 2)}${bytes(1)}`,
      ]);
    const outcome: Exchange["outcome"] = pick([
      {
        kind: "replies",
        replies: Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
          sender: id(),
          messages: Array.from({ length: 1 + Math.floor(next() * 3) }, message),
        })),
      },
      { kind: "no-response", message: pick(["no control unit answered", "NO DATA", ""]) },
      {
        kind: "adapter-error",
        error: pick(["ElmError", "AdapterUnsupported"] as const),
        message: pick(["?", "CAN ERROR", "é"]),
      },
      {
        kind: "transport-error",
        error: pick(["TransportError", "TransportTimeout"] as const),
        message: "lost",
      },
    ]);
    return {
      seq,
      at: Math.max(0, at),
      session: Math.floor(next() * 2),
      bus: pick([
        null,
        CAN,
        { kind: "can", idBits: 29, bitrate: 250_000 },
        { kind: "kline", scheme: "iso9141", tester: 0xf1, headerFormat: 0x68 },
      ] as const),
      address,
      protocol: pick([null, "obd", "uds", "kwp2000"] as const),
      request,
      outcome,
    };
  });
  return handBuilt(exchanges, {
    startedAt: 1_700_000_000_000,
    endedAt: Math.max(1_700_000_000_000, ...exchanges.map((item) => item.at)),
    sessions: [SESSION, { ...SESSION, tool: { name: "obd-read", version: String(seed) } }],
    notes: next() < 0.5 ? [] : [`note ${String(seed)}`],
  });
}

const codecs: readonly (readonly [string, ShareCodec])[] = [
  ["zlib", zlibShareCodec],
  ["streams", streamShareCodec],
];

describe.each(codecs)("a packed capture link through the %s codec", (_name, codec) => {
  it("decodes to exactly the capture recorded from the simulator", async () => {
    const scanned = await record(W211, async (elm) => {
      await scan(elm, W211, { faults: true, freeze: true });
      await elm.addressFunctional(FUNCTIONAL_ID[11]);
      await obdReport(elm, () => undefined);
    });
    const swept = await record(MQB, (elm) => sweep(elm, "uds", 1, 0x700, 0x7ff));
    for (const [label, capture] of [
      ["scan and OBD-II reads", scanned],
      ["identifier sweep", swept],
      ["scan with real gaps", timed(scanned, 3)],
      ["sweep with real gaps", timed(swept, 4)],
    ] as const) {
      expect(capture.exchanges.length, label).toBeGreaterThan(0);
      await expectRoundTrip(capture, codec, label);
    }
  });

  it("decodes to exactly each hand-built edge case", async () => {
    for (const [label, capture] of edgeCases()) await expectRoundTrip(capture, codec, label);
  });

  it("decodes to exactly random captures", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      await expectRoundTrip(randomCapture(seed), codec, `seed ${String(seed)}`);
    }
  });
});

describe("the packed form", () => {
  it("makes a sweep link a fraction of the JSON form's length", async () => {
    const swept = timed(await record(MQB, (elm) => sweep(elm, "uds", 1, 0x700, 0x7ff)), 9);
    const envelope = envelopeOf(swept);
    const packed = await fragmentOf(envelope);
    const json = `share=1.${toBase64Url(new Uint8Array(deflateRawSync(Buffer.from(canonicalJson(envelope)), { level: 9 })))}`;
    expect(packed.length * 3).toBeLessThan(json.length);
    expect(await decodeShare(json, zlibShareCodec)).toEqual({ ok: true, value: envelope });
  });

  it("overwrites the VIN in the packed bytes, as text and as hexadecimal", async () => {
    const capture = await record(MQB, async (elm) => {
      await scan(elm, MQB, { faults: true, freeze: false });
      await elm.addressFunctional(FUNCTIONAL_ID[11]);
      await obdReport(elm, () => undefined);
    });
    const envelope = envelopeOf(capture);
    const contains = (fragment: string): boolean => {
      const packed = fromBase64Url(fragment.slice("share=2.".length));
      if (packed === undefined) throw new Error("not base64url");
      const text = Buffer.from(inflateRawSync(packed)).toString("latin1");
      return text.includes(VIN) || text.includes(Buffer.from(VIN).toString("hex").toUpperCase());
    };
    expect(contains(await fragmentOf(envelope))).toBe(true);
    const redacted = await fragmentOf(envelope, zlibShareCodec, true);
    expect(contains(redacted)).toBe(false);
    const result = await decodeShare(redacted, zlibShareCodec);
    if (!result.ok || result.value.kind !== "capture") throw new Error("not a capture");
    expect(result.value.data.redacted).toBe(true);
    expect(JSON.stringify(result.value)).toContain("2A".repeat(VIN.length));
  });

  it("refuses a packed capture that would expand past the decoded limit", async () => {
    // Identical no-response exchanges pack to almost nothing, so the payload is small however many there are.
    const many = handBuilt(
      Array.from({ length: 4000 }, (_item, seq) =>
        exchange(seq, { outcome: { kind: "no-response", message: "no control unit answered" } }),
      ),
    );
    const envelope = envelopeOf(many);
    expect(canonicalJson(envelope).length).toBeGreaterThan(MAX_DECODED_BYTES);
    expect(await encodeShare(envelope, zlibShareCodec)).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "decoded" },
    });
    const payload = packedSharePayload(envelope);
    expect(payload.length).toBeLessThan(MAX_DECODED_BYTES);
    const fragment = `share=2.${toBase64Url(new Uint8Array(deflateRawSync(payload)))}`;
    expect(fragment.length).toBeLessThan(MAX_ENCODED_LENGTH);
    expect(await decodeShare(fragment, zlibShareCodec)).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "decoded", limit: MAX_DECODED_BYTES },
    });
  });

  it("refuses a link over the encoded limit", async () => {
    const next = random(11);
    const noisy = handBuilt(
      Array.from({ length: 600 }, (_item, seq) =>
        exchange(seq, {
          request: "2101",
          outcome: {
            kind: "replies",
            replies: [
              {
                sender: 0x7e8,
                messages: [
                  Array.from({ length: 60 }, () =>
                    Math.floor(next() * 256)
                      .toString(16)
                      .toUpperCase()
                      .padStart(2, "0"),
                  ).join(""),
                ],
              },
            ],
          },
        }),
      ),
    );
    expect(await encodeShare(envelopeOf(noisy), zlibShareCodec)).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "encoded", limit: MAX_ENCODED_LENGTH },
    });
  });

  it("reports malformed packed payloads as errors and never throws", async () => {
    const capture = edgeCases().find(([label]) => label.startsWith("multi-frame"))?.[1];
    if (capture === undefined) throw new Error("no edge case");
    const payload = packedSharePayload(envelopeOf(capture));
    const link = (bytes: Uint8Array): string =>
      `share=2.${toBase64Url(new Uint8Array(deflateRawSync(bytes)))}`;
    const head = (json: string): Uint8Array => {
      const text = Buffer.from(json);
      return Uint8Array.from([
        (text.length & 0x7f) | (text.length > 0x7f ? 0x80 : 0),
        ...(text.length > 0x7f ? [text.length >> 7] : []),
        ...text,
      ]);
    };
    const cases: readonly (readonly [string, Uint8Array, string])[] = [
      ["empty", new Uint8Array(0), "malformed"],
      ["trailing byte", Uint8Array.from([...payload, 0]), "malformed"],
      ["truncated", payload.slice(0, -1), "malformed"],
      ["head longer than the payload", Uint8Array.of(0x7f, 0x5b), "malformed"],
      ["head not shortest", Uint8Array.of(0x82, 0x00, 0x5b, 0x5d), "malformed"],
      ["head not JSON", head("[nope"), "malformed"],
      ["head not a list", head('{"kind":"capture"}'), "unsupported-kind"],
      ["unknown kind", head('["firmware",{}]'), "unsupported-kind"],
      ["capture head of the wrong shape", head('["capture",1]'), "invalid"],
      ["forbidden key", head('["scan",{"__proto__":{}}]'), "invalid"],
      [
        "other kind with packed bytes",
        Uint8Array.from([
          ...head(
            '["run-summary",{"v":1,"kind":"run-summary","createdAt":1,"data":{"run":{"profile":"p","adapter":"a","startedAt":1,"stoppedAt":null,"notes":""},"signals":[]}}]',
          ),
          0,
        ]),
        "malformed",
      ],
      [
        "kind unlike its envelope",
        head(
          '["scan",{"v":1,"kind":"run-summary","createdAt":1,"data":{"run":{"profile":"p","adapter":"a","startedAt":1,"stoppedAt":null,"notes":""},"signals":[]}}]',
        ),
        "malformed",
      ],
    ];
    for (const [name, bytes, code] of cases) {
      const result = await decodeShare(link(bytes), zlibShareCodec);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error.code, name).toBe(code);
    }
    // Every single-byte change either decodes to a valid envelope or is a typed error; none throws.
    for (let index = 0; index < payload.length; index++) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const changed = payload.slice();
        changed[index] = (changed[index] ?? 0) ^ flip;
        const result = await decodeShare(link(changed), zlibShareCodec);
        if (result.ok) expect(result.value.kind).toBe("capture");
        else
          expect([
            "malformed",
            "invalid",
            "unsupported-kind",
            "unsupported-version",
            "too-large",
          ]).toContain(result.error.code);
      }
    }
  });
});

describe("describeLinkLength", () => {
  it("says whether a link is over the length chat apps keep whole", () => {
    expect(describeLinkLength(PRACTICAL_LINK_LENGTH)).toMatch(/within the 2000/);
    expect(describeLinkLength(PRACTICAL_LINK_LENGTH + 1)).toMatch(
      /2001 characters, over the 2000 .* may cut it/,
    );
  });
});
