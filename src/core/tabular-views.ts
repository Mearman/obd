/**
 * The tabular views of scan, OBD-II and capture data: each column set is defined once here, so the app's downloads and the command line's `--format` output cannot drift apart. This module is platform-free.
 *
 * Every view is a {@link TableSpec} plus a function that turns the data into its rows; {@link renderTable} writes it as CSV, TSV or JSON. Times are ISO 8601 with milliseconds in UTC, byte strings are upper-case hexadecimal, and a cell with nothing to say is empty.
 */

import type { Exchange } from "./exchange.js";
import type { ObdScan } from "./obd-scan.js";
import type { DecodedCaptureData, UnitReportData } from "./service.js";
import type { TableSpec } from "./tabular.js";

/** A fault code's explanation: the text for `code` as `unit` reported it, or `undefined` when none is known. */
export type CodeDescriber = (unit: string, code: string) => string | undefined;

/** One stored fault code. */
export interface FaultCodeRow {
  /** The unit's name in its profile, or the sender's response identifier for a generic OBD-II read. */
  readonly unit: string;
  readonly code: string;
  /** The status byte as the unit gave it, or for a generic OBD-II read the kind of code: `stored`, `pending` or `permanent`. */
  readonly status: string;
  /** What the code means where a name is known, else empty. */
  readonly description: string;
}

/** Fault codes: columns `unit`, `code`, `status` and `description`, one row per code. */
export const FAULT_CODE_TABLE: TableSpec<FaultCodeRow> = {
  columns: [
    { header: "unit", cell: (row) => row.unit },
    { header: "code", cell: (row) => row.code },
    { header: "status", cell: (row) => row.status },
    { header: "description", cell: (row) => row.description },
  ],
};

/** The fault codes of a scan's units, one row each in unit order. A unit whose codes were not read has none. */
export function faultCodeRows(
  units: readonly Pick<UnitReportData, "unit" | "faults">[],
  describe?: CodeDescriber,
): FaultCodeRow[] {
  return units.flatMap((unit) =>
    (unit.faults ?? []).map((fault) => ({
      unit: unit.unit,
      code: fault.code,
      status: fault.status,
      description: describe?.(unit.unit, fault.code) ?? "",
    })),
  );
}

/** The fault codes of a generic OBD-II read: per unit its stored, pending and permanent codes, with the kind as the status. */
export function obdFaultCodeRows(scan: ObdScan, describe?: CodeDescriber): FaultCodeRow[] {
  return scan.units.flatMap((unit) =>
    (["stored", "pending", "permanent"] as const).flatMap((kind) =>
      (unit[kind] ?? []).map((code) => ({
        unit: unit.sender,
        code,
        status: kind,
        description: describe?.(unit.sender, code) ?? "",
      })),
    ),
  );
}

/** One identification value. */
export interface IdentificationRow {
  /** The unit's name, or for a generic OBD-II read the sender's response identifier; empty for the VIN. */
  readonly unit: string;
  /** What the value is, such as `VIN` or `Part number`. */
  readonly label: string;
  /** The bytes as upper-case hexadecimal, or empty where the value was not read as bytes. */
  readonly hex: string;
  /** The value as text. */
  readonly text: string;
}

/** Identification values: columns `unit`, `label`, `hex` and `text`, one row per value. */
export const IDENTIFICATION_TABLE: TableSpec<IdentificationRow> = {
  columns: [
    { header: "unit", cell: (row) => row.unit },
    { header: "label", cell: (row) => row.label },
    { header: "hex", cell: (row) => row.hex },
    { header: "text", cell: (row) => row.text },
  ],
};

/** The identification values of a scan's units, one row each in unit order. */
export function identificationRows(
  units: readonly Pick<UnitReportData, "unit" | "identification">[],
): IdentificationRow[] {
  return units.flatMap((unit) =>
    unit.identification.map((value) => ({
      unit: unit.unit,
      label: value.label,
      hex: value.hex,
      text: value.text,
    })),
  );
}

/** The identification values of a generic OBD-II read: the VIN where one was reported, then each unit's calibration identifiers. */
export function obdIdentificationRows(scan: ObdScan): IdentificationRow[] {
  const vin: IdentificationRow[] =
    scan.vin === null ? [] : [{ unit: "", label: "VIN", hex: "", text: scan.vin }];
  return [
    ...vin,
    ...scan.units.flatMap((unit) =>
      unit.calibrationIds.map((text) => ({
        unit: unit.sender,
        label: "calibration identifier",
        hex: "",
        text,
      })),
    ),
  ];
}

/** One decoded value of a capture. */
export interface DecodedValueRow {
  /** When the request it was read from was sent, in milliseconds since the Unix epoch. */
  readonly at: number;
  readonly unit: string;
  /** The value's stable name in the profile. */
  readonly name: string;
  readonly label: string;
  /** The number, or `undefined` when the reply could not be decoded. */
  readonly reading: number | undefined;
  readonly measure: string;
  /** Why the reply could not be decoded, else empty. */
  readonly error: string;
}

/** Decoded capture values: columns `time`, `unit`, `name`, `label`, `reading`, `measure` and `error`, one row per decoded value. */
export const DECODED_VALUE_TABLE: TableSpec<DecodedValueRow> = {
  columns: [
    { header: "time", cell: (row) => new Date(row.at).toISOString() },
    { header: "unit", cell: (row) => row.unit },
    { header: "name", cell: (row) => row.name },
    { header: "label", cell: (row) => row.label },
    { header: "reading", cell: (row) => (row.reading === undefined ? "" : String(row.reading)) },
    { header: "measure", cell: (row) => row.measure },
    { header: "error", cell: (row) => row.error },
  ],
};

/**
 * The decoded values of a capture with the time of the exchange each came from.
 *
 * @throws Error when a value names an exchange the capture does not hold.
 */
export function decodedValueRows(
  values: readonly DecodedCaptureData["values"][number][],
  exchanges: readonly Pick<Exchange, "seq" | "at">[],
): DecodedValueRow[] {
  const times = new Map(exchanges.map((exchange) => [exchange.seq, exchange.at]));
  return values.map((value) => {
    const at = times.get(value.seq);
    if (at === undefined)
      throw new Error(
        `value ${value.name} names exchange ${String(value.seq)}, which the capture does not hold`,
      );
    const failed = typeof value.value === "number" ? undefined : value.value.error;
    return {
      at,
      unit: value.unit,
      name: value.name,
      label: value.label,
      reading: typeof value.value === "number" ? value.value : undefined,
      measure: value.measure,
      error: failed ?? "",
    };
  });
}

/** One reply to a request, or the request alone when nothing replied. */
export interface ExchangeRow {
  readonly at: number;
  /** The request's CAN identifier as upper-case hexadecimal, empty on a bus or address that has none. */
  readonly requestId: string;
  /** The request bytes. */
  readonly request: string;
  /** The reply's sender as upper-case hexadecimal, empty when nothing replied. */
  readonly responseId: string;
  /** The sender's reply messages joined by a space, empty when nothing replied. */
  readonly response: string;
  /** `replies`, or what ended the exchange: `no-response`, `adapter-error` or `transport-error`, with the message after a colon. */
  readonly outcome: string;
}

/** Raw exchanges: columns `time`, `request id`, `request`, `response id`, `response` and `outcome`, one row per sender's reply (one row for an exchange nobody answered). */
export const EXCHANGE_TABLE: TableSpec<ExchangeRow> = {
  columns: [
    { header: "time", cell: (row) => new Date(row.at).toISOString() },
    { header: "request id", cell: (row) => row.requestId },
    { header: "request", cell: (row) => row.request },
    { header: "response id", cell: (row) => row.responseId },
    { header: "response", cell: (row) => row.response },
    { header: "outcome", cell: (row) => row.outcome },
  ],
};

function identifier(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : value.toString(16).toUpperCase();
}

/** The rows of raw exchanges in the order given. */
export function exchangeRows(exchanges: readonly Exchange[]): ExchangeRow[] {
  return exchanges.flatMap((exchange): ExchangeRow[] => {
    const requestId = identifier(exchange.address?.requestId);
    const { outcome } = exchange;
    const base = { at: exchange.at, requestId, request: exchange.request };
    if (outcome.kind === "replies") {
      return outcome.replies.map((reply) => ({
        ...base,
        responseId: identifier(reply.sender),
        response: reply.messages.join(" "),
        outcome: "replies",
      }));
    }
    return [
      { ...base, responseId: "", response: "", outcome: `${outcome.kind}: ${outcome.message}` },
    ];
  });
}
