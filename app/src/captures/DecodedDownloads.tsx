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
import { DownloadMenu, tableDownload } from "../tabular/TableDownloads";

/**
 * A Download menu for a capture's tables as CSV and TSV: the decoded values with their times, the fault codes and identification values the decoding found, and every raw exchange. A decoding under no profile reads its fault codes and identification from the OBD-II report. A code's description comes from the describer the command line's `decode` uses: the generic titles under no profile, the decoding profile's code tables under one. The menu appears once the descriptions are loaded.
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
    <DownloadMenu
      tables={[
        tableDownload(
          "decoded values",
          `${capture.id}-values`,
          DECODED_VALUE_TABLE,
          decodedValueRows(decoded.values, capture.exchanges),
        ),
        tableDownload("decoded fault codes", `${capture.id}-fault-codes`, FAULT_CODE_TABLE, faults),
        tableDownload(
          "decoded identification",
          `${capture.id}-identification`,
          IDENTIFICATION_TABLE,
          identification,
        ),
        tableDownload(
          "raw exchanges",
          `${capture.id}-exchanges`,
          EXCHANGE_TABLE,
          exchangeRows(capture.exchanges),
        ),
      ]}
    />
  );
}
