import type { Capture, DecodedCaptureData, Exchange } from "obd-read";
import { useMemo } from "react";
import { formatReadingWithUnit } from "../format/reading";
import { GENERIC_TITLE } from "../profiles/generic";
import { ObdReport } from "../screens/ObdReport";
import { FaultCodesTable, ScanResultsTable } from "../screens/ScanResults";
import { list, muted, transcript } from "../screens/screen.css";
import { Badge, DataTable, type Column } from "../ui";
import { RAW_COLUMNS } from "./exchange-columns";

/** The most rows either exchange table draws, so a capture of any length keeps the page responsive; the playback list above scrolls through every exchange. */
const MAX_TABLE_ROWS = 200;

/** One exchange of a capture with whether the chosen profile decoded it. */
interface MarkedExchange {
  readonly exchange: Exchange;
  readonly decoded: boolean;
}

const MARKED_COLUMNS: readonly Column<MarkedExchange>[] = [
  ...RAW_COLUMNS.map((column): Column<MarkedExchange> => ({
    header: column.header,
    render: ({ exchange }) => column.render(exchange),
  })),
  {
    header: "Decoding",
    render: ({ decoded }) =>
      decoded ? <Badge tone="success">Decoded</Badge> : <Badge tone="warning">Left raw</Badge>,
  },
];

/**
 * What one decoding of a capture says: how many exchanges the profile decoded and how many it left raw, the units, values, sweep results and OBD-II report it decoded, every exchange marked Decoded or Left raw, the raw ones on their own, and the decoding as text.
 */
export function DecodedView({
  capture,
  decoded,
}: {
  readonly capture: Capture;
  readonly decoded: DecodedCaptureData;
}) {
  const marked = useMemo(() => {
    const left = new Set(decoded.undecoded);
    return capture.exchanges.map((exchange) => ({ exchange, decoded: !left.has(exchange.seq) }));
  }, [capture, decoded]);
  const raw = marked.filter((item) => !item.decoded).map((item) => item.exchange);
  const name = decoded.profile?.name ?? GENERIC_TITLE;

  return (
    <>
      <p role="status" aria-label="Decoding summary">
        <Badge tone="success">Decoded {String(decoded.exchanges - raw.length)}</Badge>{" "}
        <Badge tone={raw.length > 0 ? "warning" : "neutral"}>Left raw {String(raw.length)}</Badge>{" "}
        of {String(decoded.exchanges)} exchanges with {name}.
      </p>
      {decoded.units.length > 0 && (
        <>
          <ScanResultsTable label={`Units decoded with ${name}`} units={decoded.units} />
          <FaultCodesTable label="Decoded fault codes" units={decoded.units} />
        </>
      )}
      {decoded.values.length > 0 && (
        <DataTable
          label="Decoded values"
          columns={[
            { header: "Unit", render: (value) => value.unit },
            { header: "Value", render: (value) => value.label },
            {
              header: "Reading",
              render: (value) =>
                typeof value.value === "number"
                  ? formatReadingWithUnit(value.value, value.measure)
                  : `not decoded (${value.value.error})`,
            },
          ]}
          rows={decoded.values}
          rowKey={(value) => `${value.unit}-${value.name}`}
        />
      )}
      {decoded.discovered.length > 0 && (
        <ul className={list} aria-label="Units a sweep found">
          {decoded.discovered.map((found) => (
            <li key={`${String(found.requestId)}-${String(found.responseId)}`}>
              {found.requestId.toString(16).toUpperCase()} answered from{" "}
              {found.responseId.toString(16).toUpperCase()}: {found.detail}
            </li>
          ))}
        </ul>
      )}
      {decoded.obd !== null && <ObdReport scan={decoded.obd} />}
      {raw.length > 0 ? (
        <DataTable
          label={`Exchanges ${name} leaves raw`}
          columns={RAW_COLUMNS}
          rows={raw.slice(0, MAX_TABLE_ROWS)}
          rowKey={(exchange) => String(exchange.seq)}
        />
      ) : (
        <p className={muted}>This profile decodes every exchange in the capture.</p>
      )}
      {raw.length > MAX_TABLE_ROWS && (
        <p className={muted}>
          Showing the first {String(MAX_TABLE_ROWS)} of {String(raw.length)} exchanges left raw.
        </p>
      )}
      <details>
        <summary>Every exchange, marked decoded or left raw</summary>
        <DataTable
          label={`Every exchange under ${name}`}
          columns={MARKED_COLUMNS}
          rows={marked.slice(0, MAX_TABLE_ROWS)}
          rowKey={({ exchange }) => String(exchange.seq)}
        />
        {marked.length > MAX_TABLE_ROWS && (
          <p className={muted}>
            Showing the first {String(MAX_TABLE_ROWS)} of {String(marked.length)} exchanges.
          </p>
        )}
      </details>
      <details>
        <summary>The decoding as text</summary>
        <pre className={transcript}>{decoded.lines.join("\n")}</pre>
      </details>
    </>
  );
}
