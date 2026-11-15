import { describe, expect, it } from "vitest";
import {
  DECODED_VALUE_TABLE,
  EXCHANGE_TABLE,
  FAULT_CODE_TABLE,
  IDENTIFICATION_TABLE,
  decodedValueRows,
  exchangeRows,
  faultCodeRows,
  identificationRows,
  obdFaultCodeRows,
  obdIdentificationRows,
  renderTable,
  tableHeader,
  type Exchange,
  type ObdScan,
} from "../src/core/index.js";

const UNITS = [
  {
    unit: "engine",
    faults: [
      { code: "P0420", status: "2F" },
      { code: "P0101", status: "08" },
    ],
    identification: [{ label: "Part number", hex: "4142", text: "AB" }],
  },
  { unit: "abs", faults: null, identification: [] },
];

const EXCHANGE = (overrides: Partial<Exchange>): Exchange => ({
  seq: 0,
  at: 1_790_000_000_000,
  session: 0,
  bus: null,
  address: { mode: "physical", requestId: 0x7e0, responseId: 0x7e8, extendedAddress: null },
  protocol: null,
  request: "0100",
  outcome: { kind: "no-response", message: "NO DATA" },
  ...overrides,
});

describe("the column sets", () => {
  it("name their columns once", () => {
    expect(tableHeader(FAULT_CODE_TABLE)).toEqual(["unit", "code", "status", "description"]);
    expect(tableHeader(IDENTIFICATION_TABLE)).toEqual(["unit", "label", "hex", "text"]);
    expect(tableHeader(DECODED_VALUE_TABLE)).toEqual([
      "time",
      "unit",
      "name",
      "label",
      "reading",
      "measure",
      "error",
    ]);
    expect(tableHeader(EXCHANGE_TABLE)).toEqual([
      "time",
      "request id",
      "request",
      "response id",
      "response",
      "outcome",
    ]);
  });
});

describe("fault code rows", () => {
  it("gives one row per code with a description where one is known", () => {
    const rows = faultCodeRows(UNITS, (unit, code) =>
      code === "P0420" ? `${unit} catalyst` : undefined,
    );
    expect(renderTable("tsv", FAULT_CODE_TABLE, rows)).toBe(
      "unit\tcode\tstatus\tdescription\nengine\tP0420\t2F\tengine catalyst\nengine\tP0101\t08\t\n",
    );
  });

  it("gives a generic OBD-II read's stored, pending and permanent codes the kind as status", () => {
    const scan: ObdScan = {
      vin: "SIMULATEDCAR00001",
      units: [
        {
          sender: "7E8",
          lampOn: true,
          codeCount: 1,
          stored: ["P0420"],
          pending: [],
          permanent: ["P0300"],
          readiness: null,
          freezeFrame: null,
          misfire: [],
          calibrationIds: ["CAL1"],
        },
      ],
      values: [],
      monitorResults: [],
      notes: [],
    };
    expect(obdFaultCodeRows(scan).map((row) => [row.unit, row.code, row.status])).toEqual([
      ["7E8", "P0420", "stored"],
      ["7E8", "P0300", "permanent"],
    ]);
    expect(obdIdentificationRows(scan).map((row) => [row.unit, row.label, row.text])).toEqual([
      ["", "VIN", "SIMULATEDCAR00001"],
      ["7E8", "calibration identifier", "CAL1"],
    ]);
  });
});

describe("identification rows", () => {
  it("gives one row per value", () => {
    expect(identificationRows(UNITS)).toEqual([
      { unit: "engine", label: "Part number", hex: "4142", text: "AB" },
    ]);
  });
});

describe("decoded value rows", () => {
  it("carry the time of the exchange each value came from and why one failed", () => {
    const rows = decodedValueRows(
      [
        { unit: "engine", name: "rpm", label: "Engine speed", measure: "rpm", value: 812, seq: 3 },
        {
          unit: "engine",
          name: "boost",
          label: "Boost",
          measure: "kPa",
          value: { error: "short" },
          seq: 4,
        },
      ],
      [
        { seq: 3, at: 1_790_000_000_000 },
        { seq: 4, at: 1_790_000_001_500 },
      ],
    );
    expect(renderTable("csv", DECODED_VALUE_TABLE, rows)).toBe(
      "time,unit,name,label,reading,measure,error\r\n" +
        "2026-09-21T14:13:20.000Z,engine,rpm,Engine speed,812,rpm,\r\n" +
        "2026-09-21T14:13:21.500Z,engine,boost,Boost,,kPa,short\r\n",
    );
  });

  it("refuses a value whose exchange is missing", () => {
    expect(() =>
      decodedValueRows([{ unit: "u", name: "n", label: "l", measure: "", value: 1, seq: 9 }], []),
    ).toThrow(/exchange 9/);
  });
});

describe("exchange rows", () => {
  it("give one row per sender's reply and one for an exchange nobody answered", () => {
    const rows = exchangeRows([
      EXCHANGE({
        outcome: {
          kind: "replies",
          replies: [
            { sender: 0x7e8, messages: ["410C1AF8"] },
            { sender: 0x7e9, messages: ["7F1012", "7F1013"] },
          ],
        },
      }),
      EXCHANGE({ seq: 1, request: "0902" }),
    ]);
    expect(rows.map((row) => [row.requestId, row.responseId, row.response, row.outcome])).toEqual([
      ["7E0", "7E8", "410C1AF8", "replies"],
      ["7E0", "7E9", "7F1012 7F1013", "replies"],
      ["7E0", "", "", "no-response: NO DATA"],
    ]);
  });

  it("leave the request id empty for an unaddressed exchange", () => {
    expect(exchangeRows([EXCHANGE({ address: null })])[0]?.requestId).toBe("");
  });
});
