import type { ObdScan } from "obd-read";
import { Badge, Card, DataTable, type Column } from "../ui";
import { list, muted } from "./screen.css";

type Value = ObdScan["values"][number];
type MonitorResult = ObdScan["monitorResults"][number];

const VALUE_COLUMNS: readonly Column<Value>[] = [
  { header: "Value", render: (row) => row.signal },
  { header: "Reading", render: (row) => String(row.value) },
  { header: "Unit", render: (row) => row.unit },
];

const MONITOR_COLUMNS: readonly Column<MonitorResult>[] = [
  { header: "Monitor", render: (row) => row.monitor },
  { header: "Test", render: (row) => row.test },
  { header: "Value", render: (row) => String(row.value) },
  { header: "Limits", render: (row) => `${String(row.minimum)} to ${String(row.maximum)}` },
  {
    header: "Result",
    render: (row) => (
      <Badge tone={row.withinLimits ? "success" : "warning"}>
        {row.withinLimits ? "Within limits" : "Outside limits"}
      </Badge>
    ),
  },
];

/** The VIN as shown: a VIN that sharing removed is `""`, which reads as removed rather than as an empty value. */
function vinText(vin: string | null): string {
  return vin === null ? "not reported" : vin === "" ? "removed" : vin;
}

function codes(found: readonly string[] | null): string {
  return found === null ? "not read" : found.length === 0 ? "none" : found.join(", ");
}

/**
 * What the legislated OBD-II reads said beyond the per-unit table: the VIN, each unit's lamp, codes of every kind, readiness and freeze frame, the supported live values and the mode 06 results. Mode 06 meanings differ per maker, so they are shown as read.
 */
export function ObdReport({ scan }: { readonly scan: ObdScan }) {
  return (
    <>
      <Card title="Vehicle" description={`VIN: ${vinText(scan.vin)}`}>
        {scan.units.map((unit) => (
          <div key={unit.sender}>
            <p>
              Unit {unit.sender}: warning lamp{" "}
              {unit.lampOn === null ? "not reported" : unit.lampOn ? "on" : "off"}.
            </p>
            <ul className={list}>
              <li>Stored codes: {codes(unit.stored)}</li>
              <li>Pending codes: {codes(unit.pending)}</li>
              <li>Permanent codes: {codes(unit.permanent)}</li>
              {unit.readiness !== null && (
                <li>
                  Monitors not complete: {unit.readiness.incomplete.join(", ") || "none"}; complete:{" "}
                  {unit.readiness.complete.join(", ") || "none"}
                </li>
              )}
              {unit.freezeFrame !== null && (
                <li>
                  Freeze frame for {unit.freezeFrame.code ?? "no code"}:{" "}
                  {Object.entries(unit.freezeFrame.values)
                    .map(([name, value]) => `${name} ${value}`)
                    .join(", ") || "no values"}
                </li>
              )}
            </ul>
          </div>
        ))}
        {scan.notes.map((note) => (
          <p key={note} className={muted}>
            {note}
          </p>
        ))}
      </Card>
      {scan.values.length > 0 && (
        <DataTable
          label="Live values at the scan"
          columns={VALUE_COLUMNS}
          rows={scan.values}
          rowKey={(row) => `${row.sender}-${row.signal}`}
        />
      )}
      {scan.monitorResults.length > 0 && (
        <DataTable
          label="Monitor test results"
          columns={MONITOR_COLUMNS}
          rows={scan.monitorResults}
          rowKey={(row) => `${row.sender}-${row.monitor}-${row.test}`}
        />
      )}
    </>
  );
}
