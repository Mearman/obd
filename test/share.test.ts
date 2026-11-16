import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_DECODED_BYTES,
  MAX_ENCODED_LENGTH,
  MAX_SERIES_POINTS,
  aggregateSamples,
  canonicalJson,
  decodeShare,
  describeSharedScan,
  encodeShare,
  fragmentOfLink,
  fromBase64Url,
  isIdentifyingLabel,
  redactObdReport,
  redactScan,
  redactVinShapes,
  runExportShareData,
  runSummaryShareData,
  savedTime,
  scanShareFromUnits,
  shareContents,
  unitReportOf,
  scanShareData,
  shareLink,
  sharedScanReport,
  thin,
  toBase64Url,
  type ObdReportShareData,
  type ScanShareData,
  type ShareCodec,
  type ShareEnvelope,
} from "../src/core/share.js";
import { parseScan } from "../src/core/scancompare.js";
import { streamShareCodec } from "../src/web/share-codec.js";
import { zlibShareCodec } from "../src/node/share-codec.js";

const VIN = "TESTVAN0000000001";

function scanData(overrides: Partial<ScanShareData> = {}): ScanShareData {
  return {
    taken: "2026-11-15T10:00:00+00:00",
    profile: { name: "mercedes-w211" },
    adapter: { label: "ELM327 v1.5" },
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
          "software version": { hex: "0102", text: `build for ${VIN}` },
          "serial number": { hex: "AABBCCDD", text: "SN-12345" },
        },
        faults: [
          { code: "P0001", status: "2F" },
          { code: "P0002", status: "08" },
        ],
        freeze_frames: { P0001: "00 11 22", P0002: "no freeze frame" },
      },
      {
        unit: "abs",
        description: "Brakes",
        request_id: "7E1",
        response_id: "7E9",
        answered: false,
        notes: [],
        identification: {},
        faults: null,
        freeze_frames: {},
      },
    ],
    ...overrides,
  };
}

const CALIBRATION = "CAL-ID-0000000042";

function obdData(overrides: Partial<ObdReportShareData["obd"]> = {}): ObdReportShareData {
  return {
    taken: "2026-11-15T10:00:00+00:00",
    adapter: { label: "ELM327 v1.5" },
    redacted: false,
    obd: {
      vin: VIN,
      units: [
        {
          sender: "7E8",
          lampOn: true,
          codeCount: 2,
          stored: ["P0420", "P0171"],
          pending: [],
          permanent: null,
          readiness: {
            compressionIgnition: false,
            complete: ["misfire", "catalyst"],
            incomplete: ["evaporative system"],
          },
          freezeFrame: {
            code: "P0420",
            values: { "engine speed": "800 rpm", note: `from ${VIN}` },
          },
          misfire: [{ monitor: "engine", lastCycle: 0, averageLastTenCycles: null }],
          calibrationIds: [CALIBRATION],
        },
      ],
      values: [
        { sender: "7E8", signal: "engine speed", unit: "rpm", value: 812.5 },
        { sender: "7E8", signal: "fuel system 1 status", unit: "", value: "closed loop" },
        { sender: "7E8", signal: "odd text", unit: "", value: `id ${VIN}` },
      ],
      monitorResults: [
        {
          sender: "7E8",
          monitor: "oxygen sensor bank 1 sensor 1",
          test: "07",
          scaling: "24",
          value: 100,
          minimum: 0,
          maximum: 200,
          withinLimits: true,
        },
      ],
      notes: [`read ${VIN} ok`],
      ...overrides,
    },
  };
}

function obdEnvelope(data = obdData()): ShareEnvelope {
  return { v: 1, kind: "obd-report", createdAt: 1_790_000_000_000, data };
}

function engineUnit(): ScanShareData["units"][number] {
  const unit = scanData().units[0];
  if (unit === undefined) throw new Error("no engine unit");
  return unit;
}

function scanEnvelope(data = scanData()): ShareEnvelope {
  return { v: 1, kind: "scan", createdAt: 1_790_000_000_000, data };
}

function runEnvelope(): ShareEnvelope {
  return {
    v: 1,
    kind: "run-summary",
    createdAt: 1_790_000_000_000,
    data: {
      run: {
        profile: "mercedes-w211",
        adapter: "simulator://mercedes-w211",
        startedAt: 1_790_000_000_000,
        stoppedAt: null,
        notes: "idle",
      },
      signals: [
        {
          signal: "engine speed",
          unit: "rpm",
          count: 3,
          numericCount: 3,
          min: 700,
          max: 900,
          mean: 800,
          firstAt: 1_790_000_000_000,
          lastAt: 1_790_000_002_000,
          series: [
            [0, 700],
            [1000, 800],
            [2000, 900],
          ],
        },
      ],
    },
  };
}

/** A small deterministic generator, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomText(next: () => number, max: number): string {
  const alphabet = 'abcXYZ 0123456789-_/:.éü中\u{1f697}"\\';
  const characters = Array.from(alphabet);
  const length = Math.floor(next() * max);
  let out = "";
  for (let index = 0; index < length; index++) {
    out += characters[Math.floor(next() * characters.length)] ?? "";
  }
  return out;
}

function randomObdEnvelope(seed: number, next: () => number, createdAt: number): ShareEnvelope {
  const maybe = (): boolean => next() < 0.3;
  const codes = (): string[] =>
    Array.from({ length: Math.floor(next() * 5) }, (_value, index) => `P${String(1000 + index)}`);
  const units = Array.from({ length: Math.floor(next() * 4) }, (_item, index) => ({
    sender: `7E${String(index)}`,
    lampOn: maybe() ? null : next() < 0.5,
    codeCount: maybe() ? null : Math.floor(next() * 20),
    stored: maybe() ? null : codes(),
    pending: maybe() ? null : codes(),
    permanent: maybe() ? null : codes(),
    readiness: maybe()
      ? null
      : {
          compressionIgnition: next() < 0.5,
          complete: [randomText(next, 12)],
          incomplete: [],
        },
    freezeFrame: maybe()
      ? null
      : {
          code: maybe() ? null : "P0420",
          values: Object.fromEntries(
            Array.from({ length: Math.floor(next() * 3) }, (_value, point) => [
              `value ${String(point)}`,
              randomText(next, 20),
            ]),
          ),
        },
    misfire: Array.from({ length: Math.floor(next() * 3) }, () => ({
      monitor: randomText(next, 10),
      lastCycle: maybe() ? null : Math.round(next() * 100),
      averageLastTenCycles: maybe() ? null : Math.round(next() * 1e3) / 10,
    })),
    calibrationIds: Array.from({ length: Math.floor(next() * 3) }, () => randomText(next, 16)),
  }));
  return {
    v: 1,
    kind: "obd-report",
    createdAt,
    data: {
      taken: randomText(next, 25),
      adapter: { label: randomText(next, 20) },
      redacted: next() < 0.5,
      obd: {
        vin: maybe() ? null : randomText(next, 17),
        units,
        values: Array.from({ length: Math.floor(next() * 6) }, (_value, index) => ({
          sender: "7E8",
          signal: `signal ${String(index)}`,
          unit: "rpm",
          value: next() < 0.3 ? randomText(next, 12) : Math.round(next() * 1e5) / 100,
        })),
        monitorResults: Array.from({ length: Math.floor(next() * 4) }, (_value, index) => ({
          sender: "7E8",
          monitor: `monitor ${String(index)}`,
          test: "0A",
          scaling: "24",
          value: Math.round(next() * 1e3) - 500,
          minimum: -500,
          maximum: 500,
          withinLimits: next() < 0.5,
        })),
        notes: Array.from({ length: Math.floor(next() * 3) }, () => randomText(next, 30)),
      },
    },
  };
}

function randomEnvelope(seed: number): ShareEnvelope {
  const next = random(seed);
  const createdAt = Math.floor(next() * 2_000_000_000_000);
  if (seed % 3 === 0) return randomObdEnvelope(seed, next, createdAt);
  if (next() < 0.5) {
    const units = Array.from({ length: Math.floor(next() * 6) }, (_item, unitIndex) => ({
      unit: `unit${String(unitIndex)}`,
      description: randomText(next, 30),
      request_id: "7E0",
      response_id: "7E8",
      answered: next() < 0.5,
      notes: Array.from({ length: Math.floor(next() * 3) }, () => randomText(next, 40)),
      identification: Object.fromEntries(
        Array.from({ length: Math.floor(next() * 4) }, (_value, index) => [
          `label ${String(index)}`,
          { hex: randomText(next, 10), text: randomText(next, 20) },
        ]),
      ),
      faults:
        next() < 0.2
          ? null
          : Array.from({ length: Math.floor(next() * 8) }, (_value, index) => ({
              code: `P${String(1000 + index)}`,
              status: randomText(next, 3),
            })),
      freeze_frames: Object.fromEntries(
        Array.from({ length: Math.floor(next() * 3) }, (_value, index) => [
          `P${String(1000 + index)}`,
          randomText(next, 30),
        ]),
      ),
    }));
    return {
      v: 1,
      kind: "scan",
      createdAt,
      data: {
        taken: randomText(next, 25),
        profile: { name: `profile${String(seed)}` },
        adapter: { label: randomText(next, 20) },
        redacted: next() < 0.5,
        units,
      },
    };
  }
  const signals = Array.from({ length: Math.floor(next() * 5) }, (_item, index) => ({
    signal: `signal ${String(index)}`,
    unit: "rpm",
    count: 10,
    numericCount: 10,
    min: Math.round(next() * 100) / 10,
    max: 100 + Math.round(next() * 100) / 10,
    mean: null,
    firstAt: 5,
    lastAt: 50,
    series: Array.from({ length: Math.floor(next() * 40) }, (_value, point): [number, number] => [
      point * 10,
      Math.round(next() * 1e4) / 100,
    ]),
  }));
  return {
    v: 1,
    kind: "run-summary",
    createdAt,
    data: {
      run: {
        profile: "p",
        adapter: "a",
        startedAt: 5,
        stoppedAt: next() < 0.5 ? null : 99,
        notes: randomText(next, 30),
      },
      signals,
    },
  };
}

async function encoded(
  envelope: ShareEnvelope,
  codec: ShareCodec,
  redactVin = false,
): Promise<string> {
  const result = await encodeShare(envelope, codec, { redactVin });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.fragment;
}

function payload(fragment: string): string {
  return fragment.slice(fragment.indexOf(".") + 1);
}

/** A fragment whose payload is `json` compressed as given, bypassing the encoder's own checks. */
function forged(json: string): string {
  return `share=1.${toBase64Url(new Uint8Array(deflateRawSync(Buffer.from(json))))}`;
}

const codecs: readonly (readonly [string, ShareCodec])[] = [
  ["zlib", zlibShareCodec],
  ["streams", streamShareCodec],
];

describe.each(codecs)("the %s codec", (_name, codec) => {
  it("round trips a scan, a generic OBD-II report and a run summary", async () => {
    for (const envelope of [scanEnvelope(), obdEnvelope(), runEnvelope()]) {
      const result = await decodeShare(await encoded(envelope, codec), codec);
      expect(result).toEqual({ ok: true, value: envelope });
    }
  });

  it("round trips random envelopes", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const envelope = randomEnvelope(seed);
      const result = await decodeShare(await encoded(envelope, codec), codec);
      expect(result, `seed ${String(seed)}`).toEqual({ ok: true, value: envelope });
    }
  });

  it("writes the packed form and still opens a link of the JSON form", async () => {
    for (const envelope of [scanEnvelope(), obdEnvelope(), runEnvelope()]) {
      expect(await encoded(envelope, codec)).toMatch(/^share=2\./);
      const old = forged(canonicalJson(envelope));
      expect(old).toMatch(/^share=1\./);
      expect(await decodeShare(old, codec)).toEqual({ ok: true, value: envelope });
    }
  });

  it("writes the same link for the same envelope however the keys were ordered", async () => {
    const one = scanEnvelope();
    const reordered: ShareEnvelope = {
      data: scanData(),
      createdAt: one.createdAt,
      kind: "scan",
      v: 1,
    };
    expect(await encoded(reordered, codec)).toBe(await encoded(one, codec));
  });

  it("stops inflating a bomb past the decoded limit", async () => {
    const bomb = forged(`"${"a".repeat(MAX_DECODED_BYTES * 8)}"`);
    expect(bomb.length).toBeLessThan(MAX_ENCODED_LENGTH);
    const result = await decodeShare(bomb, codec);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "decoded", limit: MAX_DECODED_BYTES, exact: false },
    });
  });

  it("reports hostile input as errors and never throws", async () => {
    const good = await encoded(scanEnvelope(), codec);
    const cases: readonly (readonly [string, string, string])[] = [
      ["empty", "", "malformed"],
      ["not a share", "other=1.abc", "malformed"],
      ["no version", "share=abc", "malformed"],
      ["future version", `share=4.${payload(good)}`, "unsupported-version"],
      ["bad base64", "share=1.!!!!", "malformed"],
      ["impossible base64 length", "share=1.A", "malformed"],
      ["truncated", good.slice(0, Math.floor(good.length / 2)), "malformed"],
      ["not deflate", `share=1.${toBase64Url(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))}`, "malformed"],
      ["not json", forged("{not json"), "malformed"],
      ["not an object", forged("[1,2]"), "invalid"],
      [
        "non ASCII bytes",
        `share=1.${toBase64Url(new Uint8Array(deflateRawSync(Buffer.from("é"))))}`,
        "malformed",
      ],
      [
        "envelope version",
        forged(JSON.stringify({ ...scanEnvelope(), v: 2 })),
        "unsupported-version",
      ],
      [
        "envelope kind",
        forged(JSON.stringify({ ...scanEnvelope(), kind: "firmware" })),
        "unsupported-kind",
      ],
      ["extra envelope field", forged(JSON.stringify({ ...scanEnvelope(), extra: 1 })), "invalid"],
      [
        "extra data field",
        forged(JSON.stringify({ ...scanEnvelope(), data: { ...scanData(), extra: 1 } })),
        "invalid",
      ],
      ["wrong type", forged(JSON.stringify({ ...scanEnvelope(), createdAt: "now" })), "invalid"],
      [
        "extra OBD-II report field",
        forged(JSON.stringify({ ...obdEnvelope(), data: { ...obdData(), extra: 1 } })),
        "invalid",
      ],
      [
        "extra OBD-II unit field",
        forged(JSON.stringify(obdEnvelope()).replace('"sender":"7E8"', '"sender":"7E8","extra":1')),
        "invalid",
      ],
      [
        "OBD-II code that is not text",
        forged(JSON.stringify(obdEnvelope()).replace('"P0420","P0171"', '"P0420",5')),
        "invalid",
      ],
      [
        "OBD-II report of another kind's shape",
        forged(JSON.stringify({ ...obdEnvelope(), data: scanData() })),
        "invalid",
      ],
      ["deep nesting", forged("[".repeat(100_000)), "malformed"],
    ];
    for (const [name, fragment, code] of cases) {
      const result = await decodeShare(fragment, codec);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error.code, name).toBe(code);
    }
  });

  it("rejects prototype pollution keys at every level", async () => {
    const polluted = JSON.stringify(scanEnvelope()).replace(
      '"identification":{"VIN"',
      '"identification":{"__proto__":{"hex":"","text":""},"VIN"',
    );
    expect(polluted).toContain("__proto__");
    const obdPolluted = JSON.stringify(obdEnvelope()).replace(
      '"values":{"engine speed"',
      '"values":{"__proto__":"x","engine speed"',
    );
    expect(obdPolluted).toContain("__proto__");
    for (const fragment of [
      forged(obdPolluted),
      forged(polluted),
      forged(`{"__proto__":{"polluted":true},"v":1,"kind":"scan","createdAt":1,"data":{}}`),
      forged(JSON.stringify(scanEnvelope()).replace('"P0001":"00 11 22"', '"constructor":"x"')),
    ]) {
      const result = await decodeShare(fragment, codec);
      expect(result.ok).toBe(false);
    }
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });

  it("refuses an oversize link before reading it", async () => {
    const result = await decodeShare(`share=1.${"A".repeat(MAX_ENCODED_LENGTH)}`, codec);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "encoded", limit: MAX_ENCODED_LENGTH, exact: true },
    });
  });

  it("refuses to write an envelope over the decoded limit, naming the size and the limit", async () => {
    const big = scanData({
      units: [{ ...engineUnit(), notes: Array.from({ length: 100 }, () => "x".repeat(4000)) }],
    });
    const result = await encodeShare(scanEnvelope(big), codec);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "too-large", stage: "decoded", limit: MAX_DECODED_BYTES },
    });
    if (!result.ok) {
      expect(result.error.message).toMatch(/limit is 262144/);
      expect(result.error.message).toMatch(/export the file/);
    }
  });

  it("refuses to write a link over the encoded limit", async () => {
    const next = random(7);
    const noisy = Array.from({ length: 60 }, () =>
      Array.from({ length: 3500 }, () => String.fromCharCode(33 + Math.floor(next() * 90))).join(
        "",
      ),
    );
    const data = scanData({ units: [{ ...engineUnit(), notes: noisy.slice(0, 50) }] });
    const result = await encodeShare(scanEnvelope(data), codec);
    expect(result).toMatchObject({ ok: false, error: { code: "too-large", stage: "encoded" } });
  });

  it("refuses an envelope that does not match its schema", async () => {
    const result = await encodeShare({ ...scanEnvelope(), createdAt: -1 }, codec);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("blanks the VIN, serial numbers and every other copy of them when asked", async () => {
    const link = await encoded(scanEnvelope(), codec, true);
    const result = await decodeShare(link, codec);
    if (!result.ok || result.value.kind !== "scan") throw new Error("not a scan");
    const text = JSON.stringify(result.value);
    expect(text).not.toContain(VIN);
    expect(text).not.toContain("SN-12345");
    expect(text).not.toContain("AABBCCDD");
    expect(result.value.data.redacted).toBe(true);
    const engine = result.value.data.units[0];
    expect(engine?.identification.VIN).toEqual({ hex: "", text: "" });
    expect(engine?.identification["software version"]?.text).toBe("build for [redacted]");
    expect(engine?.notes).toEqual(["read [redacted] ok"]);
    expect(engine?.faults).toEqual(scanData().units[0]?.faults);
  });

  it("blanks the VIN, calibration identifiers and every other copy of them in an OBD-II report when asked", async () => {
    const link = await encoded(obdEnvelope(), codec, true);
    const result = await decodeShare(link, codec);
    if (!result.ok || result.value.kind !== "obd-report") throw new Error("not an OBD-II report");
    const text = JSON.stringify(result.value);
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(CALIBRATION);
    const { data } = result.value;
    expect(data.redacted).toBe(true);
    expect(data.obd.vin).toBe("");
    expect(data.obd.notes).toEqual(["read [redacted] ok"]);
    expect(data.obd.values[2]?.value).toBe("id [redacted]");
    expect(data.obd.units[0]?.calibrationIds).toEqual([""]);
    expect(data.obd.units[0]?.freezeFrame?.values.note).toBe("from [redacted]");
    expect(data.obd.units[0]?.stored).toEqual(["P0420", "P0171"]);
  });

  it("keeps the VIN when not asked to blank it", async () => {
    const result = await decodeShare(await encoded(scanEnvelope(), codec), codec);
    expect(JSON.stringify(result)).toContain(VIN);
  });
});

describe("the two codecs", () => {
  it("read each other's links", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const envelope = randomEnvelope(seed);
      const written = await encoded(envelope, zlibShareCodec);
      expect(await decodeShare(written, streamShareCodec)).toEqual({ ok: true, value: envelope });
      const other = await encoded(envelope, streamShareCodec);
      expect(await decodeShare(other, zlibShareCodec)).toEqual({ ok: true, value: envelope });
    }
  });
});

describe("base64url", () => {
  it("round trips every length and rejects what is not its alphabet", () => {
    const next = random(3);
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256));
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
    expect(fromBase64Url("ab+/")).toBeUndefined();
    expect(fromBase64Url("abcde")).toBeUndefined();
    expect(fromBase64Url("QR")).toBeUndefined();
  });
});

describe("canonical JSON", () => {
  it("sorts keys and writes only ASCII", () => {
    expect(canonicalJson({ b: 1, a: { d: "é", c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}],"d":"\\u00e9"},"b":1}',
    );
  });
});

describe("links", () => {
  it("replaces any fragment already on the base and finds a share in a whole link or a hash", () => {
    const link = shareLink("https://example.com/obd/#old", "share=1.abc");
    expect(link).toBe("https://example.com/obd/#share=1.abc");
    expect(fragmentOfLink(link)).toBe("share=1.abc");
    expect(fragmentOfLink("#share=1.abc")).toBe("share=1.abc");
    expect(fragmentOfLink("https://example.com/obd/#other")).toBeUndefined();
    expect(fragmentOfLink("https://example.com/obd/")).toBeUndefined();
  });
});

describe("redaction", () => {
  it("blanks labels that name a VIN or a serial number and no others", () => {
    expect(
      ["VIN", "vin number", "Vehicle Identification Number", "serial number"].map(
        isIdentifyingLabel,
      ),
    ).toEqual([true, true, true, true]);
    expect(["software version", "part number", "identification"].some(isIdentifyingLabel)).toBe(
      false,
    );
  });

  it("changes nothing else about the scan", () => {
    const original = scanData();
    const redacted = redactScan(original);
    expect(redacted.units[1]).toEqual(original.units[1]);
    expect(redacted.units[0]?.faults).toEqual(original.units[0]?.faults);
    expect(original.units[0]?.identification.VIN?.text).toBe(VIN);
  });
});

describe("redaction of a VIN in an unlabelled identification block", () => {
  const BLOCK_VIN = "WDBTESTAB12345678";
  const hex = Array.from(`ID ${BLOCK_VIN} 01`, (c) => c.charCodeAt(0).toString(16)).join("");

  it("finds a VIN-shaped word in the text, the hexadecimal bytes and the notes", () => {
    const base = scanData();
    const data: ScanShareData = {
      ...base,
      units: [
        {
          ...engineUnit(),
          notes: [`vin ${BLOCK_VIN}`],
          identification: { identification: { hex, text: `ID ${BLOCK_VIN} 01` } },
          freeze_frames: {},
        },
      ],
    };
    expect(shareContents(scanEnvelope(data)).join("\n")).toMatch(/included \(1 value\)/);
    const redacted = redactScan(data);
    const text = JSON.stringify(redacted);
    expect(text).not.toContain(BLOCK_VIN);
    expect(text).not.toContain(hex.slice(6, 40));
    expect(redacted.units[0]?.identification.identification?.text).toBe("ID [redacted] 01");
    expect(shareContents(scanEnvelope(redacted)).join("\n")).toContain(
      "VIN and serial numbers: removed.",
    );
  });

  it("says so when a scan holds none", () => {
    const data: ScanShareData = {
      ...scanData(),
      units: [{ ...engineUnit(), notes: [], identification: {}, freeze_frames: {} }],
    };
    expect(shareContents(scanEnvelope(data)).join("\n")).toContain(
      "No VIN or serial number was found",
    );
  });
});

describe("a saved scan", () => {
  const saved = {
    tool: "obd-read",
    taken: "2026-11-15T10:00:00+00:00",
    profile: { name: "mercedes-w211", status: "x" },
    adapter: { identity: "ELM327 v1.5", description: null, stn_identity: null, voltage: "12.4V" },
    units: scanData().units,
    transcript: [`> 0902`, `< ${VIN}`],
  };

  it("is shared without its transcript or adapter address", () => {
    const result = scanShareData(saved);
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.stringify(result.value)).not.toContain("0902");
    expect(result.value.adapter).toEqual({ label: "ELM327 v1.5" });
    expect(result.value.units).toEqual(scanData().units);
  });

  it("rejects what is not a scan report or holds a forbidden key", () => {
    expect(scanShareData({ tool: "other" }).ok).toBe(false);
    expect(scanShareData(null).ok).toBe(false);
    const hostile: unknown = JSON.parse(
      JSON.stringify(saved).replace(
        '"freeze_frames":{"P0001"',
        '"freeze_frames":{"__proto__":"x","P0001"',
      ),
    );
    expect(scanShareData(hostile).ok).toBe(false);
  });

  it("is stored in the form compare and describe read, marked as shared", () => {
    const report = sharedScanReport(scanData());
    expect(report.origin).toBe("shared");
    const parsed = parseScan(JSON.stringify(report), "shared");
    expect(parsed.units.get("engine")?.faults?.get("P0001")).toEqual(["2F"]);
    expect(report.transcript).toEqual([]);
  });

  it("is described for the command line, saying whether the VIN was removed", () => {
    const lines = describeSharedScan(redactScan(scanData()), 1_790_000_000_000);
    expect(lines[0]).toMatch(/^shared scan \(taken 2026-11-15/);
    expect(lines).toContain("VIN and serial numbers were removed before sharing");
    expect(lines).toContain("  fault P0001 status 2F");
    expect(lines).toContain("    freeze frame 00 11 22");
    expect(lines.join("\n")).not.toContain(VIN);
  });
});

describe("a run summary", () => {
  it("thins a long series to the bound, keeping the first and last readings", () => {
    const run = {
      id: "r",
      profile: "p",
      adapter: "a",
      startedAt: 1000,
      stoppedAt: 99_000,
      notes: "",
    };
    const samples = Array.from({ length: 5000 }, (_item, index) => ({
      runId: "r",
      signal: "speed",
      unit: "km/h",
      timestamp: 1000 + index * 10,
      value: index % 7 === 0 ? "n/a" : index,
    }));
    const aggregate = {
      signal: "speed",
      unit: "km/h",
      count: 5000,
      numericCount: 4285,
      min: 1,
      max: 4999,
      mean: 2500.123_456,
      firstAt: 1000,
      lastAt: 50_990,
    };
    const summary = runSummaryShareData(run, [aggregate], samples.toReversed());
    const series = summary.signals[0]?.series ?? [];
    expect(series).toHaveLength(MAX_SERIES_POINTS);
    expect(series[0]).toEqual([10, 1]);
    expect(series.at(-1)).toEqual([49_990, 4999]);
    expect(
      series.every(([time], index) => index === 0 || time > (series[index - 1]?.[0] ?? 0)),
    ).toBe(true);
    expect(summary.signals[0]?.mean).toBe(2500.1235);
  });

  it("thins to at most the limit", () => {
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(thin([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 4, 6]);
    expect(thin([1, 2, 3], 1)).toEqual([1]);
  });

  it("stays under the practical link length for a typical run", async () => {
    const run = {
      id: "r",
      profile: "mercedes-w211",
      adapter: "ble://vLinker",
      startedAt: 0,
      stoppedAt: 600_000,
      notes: "",
    };
    const next = random(11);
    const names = ["engine speed", "coolant temperature", "vehicle speed", "throttle"];
    const samples = names.flatMap((signal) =>
      Array.from({ length: 600 }, (_item, index) => ({
        runId: "r",
        signal,
        unit: "u",
        timestamp: index * 1000,
        value: Math.round(next() * 1000) / 10,
      })),
    );
    const aggregates = names.map((signal) => ({
      signal,
      unit: "u",
      count: 600,
      numericCount: 600,
      min: 0,
      max: 100,
      mean: 50,
      firstAt: 0,
      lastAt: 599_000,
    }));
    const summary = runSummaryShareData(run, aggregates, samples);
    const result = await encodeShare(
      { v: 1, kind: "run-summary", createdAt: 1, data: summary },
      zlibShareCodec,
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fragment.length).toBeLessThan(MAX_ENCODED_LENGTH);
  });
});

describe("a scan from the service", () => {
  it("is shared with the saved report's field names and read back into the same units", () => {
    const units = scanData().units.map(unitReportOf);
    const result = scanShareFromUnits(units, {
      profile: "mercedes-w211",
      adapterLabel: "ELM327 v1.5",
      takenAt: Date.UTC(2026, 10, 15, 10, 0, 0),
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual(scanData());
    expect(savedTime(Date.UTC(2026, 10, 15, 10, 0, 0))).toBe("2026-11-15T10:00:00+00:00");
  });

  it("refuses a unit whose identification label is a forbidden key", () => {
    const [first] = scanData().units.map(unitReportOf);
    if (first === undefined) throw new Error("no unit");
    const hostile = { ...first, identification: [{ label: "__proto__", hex: "", text: "" }] };
    const result = scanShareFromUnits([hostile], { profile: "p", adapterLabel: "", takenAt: 0 });
    expect(result.ok).toBe(false);
  });
});

describe("redaction of a generic OBD-II report", () => {
  it("leaves a report without a VIN without one and changes nothing else", () => {
    const base = obdData({ vin: null });
    const redacted = redactObdReport(base);
    expect(redacted.obd.vin).toBeNull();
    expect({ ...redacted, redacted: false }).toEqual({
      ...base,
      obd: {
        ...base.obd,
        notes: ["read [redacted] ok"],
        units: base.obd.units.map((unit) => ({
          ...unit,
          calibrationIds: [""],
          freezeFrame: {
            code: "P0420",
            values: { "engine speed": "800 rpm", note: "from [redacted]" },
          },
        })),
        values: [
          ...base.obd.values.slice(0, 2),
          { sender: "7E8", signal: "odd text", unit: "", value: "id [redacted]" },
        ],
      },
    });
  });

  it("finds a VIN-shaped word that no field names as the VIN", () => {
    const redacted = redactObdReport(obdData({ vin: null }));
    expect(JSON.stringify(redacted)).not.toContain(VIN);
  });
});

describe("what a link carries", () => {
  it("lists an OBD-II report's contents, saying whether the VIN is in it", () => {
    const included = shareContents(obdEnvelope()).join("\n");
    expect(included).toMatch(/2 stored codes, 0 pending codes and 0 permanent codes/);
    expect(included).toMatch(/1 freeze frame, 3 current-data values with units and 1 mode 06/);
    expect(included).toMatch(/VIN and calibration identifiers: included/);
    const removed = shareContents(obdEnvelope(redactObdReport(obdData()))).join("\n");
    expect(removed).toMatch(/VIN and calibration identifiers: removed/);
  });

  it("lists a scan's contents, saying whether the VIN is in it", () => {
    const included = shareContents(scanEnvelope()).join("\n");
    expect(included).toContain("2 control units");
    expect(included).toContain("2 fault codes with their status bytes");
    expect(included).toContain("2 freeze frames");
    expect(included).toMatch(/VIN and serial numbers: included \(\d+ values\)/);
    expect(included).toContain("Not included: the raw adapter transcript");
    const removed = shareContents(scanEnvelope(redactScan(scanData()))).join("\n");
    expect(removed).toContain("VIN and serial numbers: removed.");
  });

  it("lists a run summary's contents", () => {
    const lines = shareContents(runEnvelope()).join("\n");
    expect(lines).toContain("1 signal with count, minimum, maximum and mean");
    expect(lines).toContain("and your notes");
  });
});

describe("a run export", () => {
  const samples = [10, 20, 30].map((value, index) => ({
    runId: "r",
    signal: "speed",
    unit: "km/h",
    timestamp: 1000 + index,
    value: index === 1 ? "n/a" : value,
  }));

  it("is summarised from its samples", () => {
    expect(aggregateSamples(samples)).toEqual([
      {
        signal: "speed",
        unit: "km/h",
        count: 3,
        numericCount: 2,
        min: 10,
        max: 30,
        mean: 20,
        firstAt: 1000,
        lastAt: 1002,
      },
    ]);
    const result = runExportShareData({
      format: "obd-read-run",
      version: 1,
      run: { id: "r", profile: "p", adapter: "a", startedAt: 1000, stoppedAt: null, notes: "" },
      samples,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.signals[0]?.series).toEqual([
      [0, 10],
      [2, 30],
    ]);
  });

  it("is refused when it is not a run export", () => {
    expect(runExportShareData({ format: "other" }).ok).toBe(false);
  });
});

describe("redactVinShapes", () => {
  it("replaces VIN-shaped words in either case and leaves other text", () => {
    expect(redactVinShapes("car WDB2110200A000000 failed")).toBe("car [redacted] failed");
    expect(redactVinShapes("car wdb2110202b121724 failed", "[vin]")).toBe("car [vin] failed");
  });

  it("also takes a word with I, O or Q, which a simulator or a misreading can produce", () => {
    expect(redactVinShapes("car SIMULATEDCAR00001 failed")).toBe("car [redacted] failed");
  });

  it("leaves seventeen-letter words, seventeen digits and longer runs alone", () => {
    expect(redactVinShapes("ABCDEFGHJKLMNPRST")).toBe("ABCDEFGHJKLMNPRST");
    expect(redactVinShapes("12345678901234567")).toBe("12345678901234567");
    expect(redactVinShapes("WDB2110200A000000X")).toBe("WDB2110200A000000X");
  });
});
