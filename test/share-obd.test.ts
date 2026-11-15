import { describe, expect, it } from "vitest";
import { fromHex } from "../src/core/index.js";
import {
  MAX_ENCODED_LENGTH,
  decodeShare,
  encodeShare,
  obdReportDocument,
  obdReportDocumentShareData,
  obdReportShareData,
  redactObdReport,
  shareLink,
  type ObdReportShareData,
  type ShareEnvelope,
} from "../src/core/share.js";
import { zlibShareCodec } from "../src/node/share-codec.js";
import { Car, RECORDED } from "./helpers/recorded-car.js";
import { loadReplies } from "./helpers/transcripts.js";

/** The calibration identifier the recorded car reports (mode 09, identifier 04). */
const RECORDED_CALIBRATION = "0034466040150284";

/** A made-up VIN, in the shape of one: the recordings do not hold the car's own. */
const MADE_UP_VIN = "TESTVAN0000000001";

const READ = { takenAt: Date.UTC(2026, 10, 14, 16, 15, 5), adapterLabel: "ELM327 v1.5" };

async function readRecorded(vin?: string): Promise<ObdReportShareData> {
  const replies = loadReplies(...RECORDED);
  if (vin !== undefined) {
    const hex = Array.from(vin, (character) => character.charCodeAt(0).toString(16)).join("");
    replies.set("0902", [[0x7e8, fromHex(`490201${hex}`)]]);
  }
  const scan = await new Car(replies).scan();
  const shared = obdReportShareData(scan, READ);
  if (!shared.ok) throw new Error(shared.error.message);
  return shared.value;
}

function envelopeOf(data: ObdReportShareData): ShareEnvelope {
  return { v: 1, kind: "obd-report", createdAt: READ.takenAt, data };
}

async function linkOf(data: ObdReportShareData, redactVin: boolean): Promise<string> {
  const encoded = await encodeShare(envelopeOf(data), zlibShareCodec, { redactVin });
  if (!encoded.ok) throw new Error(encoded.error.message);
  return shareLink("https://example.com/obd/", encoded.value.fragment);
}

async function decodedData(link: string): Promise<ObdReportShareData> {
  const result = await decodeShare(link.slice(link.indexOf("#")), zlibShareCodec);
  if (!result.ok || result.value.kind !== "obd-report") throw new Error("not an OBD-II report");
  return result.value.data;
}

describe("sharing the recorded car's generic OBD-II read", () => {
  it("makes a link that decodes to the report with its identifiers blanked", async () => {
    const original = await readRecorded();
    expect(original.obd.units.flatMap((unit) => unit.calibrationIds)).toContain(
      RECORDED_CALIBRATION,
    );
    expect(original.obd.values.length).toBeGreaterThan(0);

    const link = await linkOf(original, true);
    expect(link.length).toBeLessThan(MAX_ENCODED_LENGTH);
    const shared = await decodedData(link);

    expect(shared).toEqual(redactObdReport(original));
    expect(shared.redacted).toBe(true);
    // The recordings hold no VIN: the report has none, and redaction does not invent one.
    expect(shared.obd.vin).toBeNull();
    expect(shared.obd.units.flatMap((unit) => unit.calibrationIds).every((id) => id === "")).toBe(
      true,
    );
    expect(JSON.stringify(shared)).not.toContain(RECORDED_CALIBRATION);
  });

  it("round trips the whole report unchanged when nothing is blanked", async () => {
    const original = await readRecorded();
    expect(await decodedData(await linkOf(original, false))).toEqual(original);
  });

  it("blanks a VIN the car reports", async () => {
    const original = await readRecorded(MADE_UP_VIN);
    expect(original.obd.vin).toBe(MADE_UP_VIN);
    const link = await linkOf(original, true);
    const shared = await decodedData(link);
    expect(shared.obd.vin).toBe("");
    expect(shared).toEqual(redactObdReport(original));
    expect(JSON.stringify(shared)).not.toContain(MADE_UP_VIN);
    expect(link).not.toContain(MADE_UP_VIN);
  });

  it("is shared from the file `obd --output` writes", async () => {
    const original = await readRecorded();
    const scan = original.obd;
    const document: unknown = JSON.parse(JSON.stringify(obdReportDocument(scan, READ)));
    const result = obdReportDocumentShareData(document);
    if (!result.ok) throw new Error(result.error.message);
    const data = result.value;
    expect(data).toEqual(original);
  });
});

describe("a saved OBD-II read that is not one", () => {
  it("is refused by the share data readers", () => {
    for (const document of [
      { tool: "obd-read", format: "obd-report", taken: "x", adapter: { identity: null } },
      { tool: "obd-read", format: "other" },
      "text",
      { tool: "obd-read", format: "obd-report", taken: "x", adapter: {}, obd: {} },
    ]) {
      expect(obdReportDocumentShareData(document)).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
    }
  });
});
