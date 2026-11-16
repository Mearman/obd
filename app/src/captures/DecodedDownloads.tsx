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
  type Capture,
  type DecodedCaptureData,
} from "obd-read";
import { useCodeDescriber } from "../profiles/code-describer";
import { TableDownloads } from "../tabular/TableDownloads";

/**
 * Download buttons for a capture's tables as CSV and TSV: the decoded values with their times, the fault codes and identification values the decoding found, and every raw exchange. A decoding under no profile reads its fault codes and identification from the OBD-II report. A code's description comes from the describer the command line's `decode` uses: the generic titles under no profile, the decoding profile's code tables under one. The buttons appear once the descriptions are loaded.
 */
export function DecodedDownloads({
  capture,
  decoded,
}: {
  readonly capture: Capture;
  readonly decoded: DecodedCaptureData;
}) {
  const describe = useCodeDescriber(decoded.profile?.name ?? null, decoded.profile === null);
  if (describe === undefined) return null;
  const faults =
    decoded.profile === null
      ? decoded.obd === null
        ? []
        : obdFaultCodeRows(decoded.obd, describe)
      : faultCodeRows(decoded.units, describe);
  const identification =
    decoded.profile === null
      ? decoded.obd === null
        ? []
        : obdIdentificationRows(decoded.obd)
      : identificationRows(decoded.units);
  return (
    <>
      <TableDownloads
        label="decoded values"
        filename={`${capture.id}-values`}
        spec={DECODED_VALUE_TABLE}
        rows={decodedValueRows(decoded.values, capture.exchanges)}
      />
      <TableDownloads
        label="decoded fault codes"
        filename={`${capture.id}-fault-codes`}
        spec={FAULT_CODE_TABLE}
        rows={faults}
      />
      <TableDownloads
        label="decoded identification"
        filename={`${capture.id}-identification`}
        spec={IDENTIFICATION_TABLE}
        rows={identification}
      />
      <TableDownloads
        label="raw exchanges"
        filename={`${capture.id}-exchanges`}
        spec={EXCHANGE_TABLE}
        rows={exchangeRows(capture.exchanges)}
      />
    </>
  );
}
