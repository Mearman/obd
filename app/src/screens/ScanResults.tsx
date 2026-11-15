import type { UnitReportData } from "obd-read";
import { Badge, DataTable, type Column } from "../ui";

function faultCount(unit: UnitReportData): number {
  return unit.faults?.length ?? 0;
}

/** The columns every scan result shows: the unit, whether it answered and how many fault codes it holds. */
export const UNIT_COLUMNS: readonly Column<UnitReportData>[] = [
  { header: "Unit", render: (unit) => unit.description },
  {
    header: "Status",
    render: (unit) =>
      unit.answered ? (
        <Badge tone={faultCount(unit) > 0 ? "warning" : "success"}>
          {faultCount(unit) > 0 ? "Faults stored" : "No faults"}
        </Badge>
      ) : (
        <Badge>No reply</Badge>
      ),
  },
  { header: "Fault codes", render: (unit) => (unit.answered ? String(faultCount(unit)) : "-") },
];

/** A scan's units as a table; `extraColumns` follow the shared ones (the Scan screen adds its Clear column). */
export function ScanResultsTable({
  label,
  units,
  extraColumns = [],
}: {
  readonly label: string;
  readonly units: readonly UnitReportData[];
  readonly extraColumns?: readonly Column<UnitReportData>[];
}) {
  return (
    <DataTable
      label={label}
      columns={[...UNIT_COLUMNS, ...extraColumns]}
      rows={units}
      rowKey={(unit) => unit.unit}
    />
  );
}

interface FaultRow {
  readonly key: string;
  readonly unit: string;
  readonly code: string;
  readonly status: string;
  readonly freezeFrame: string;
}

/** Every stored fault code of a scan with its status byte and freeze frame, one row each. */
export function FaultCodesTable({
  label,
  units,
}: {
  readonly label: string;
  readonly units: readonly UnitReportData[];
}) {
  const rows = units.flatMap((unit) =>
    (unit.faults ?? []).map((fault, index): FaultRow => ({
      key: `${unit.unit}-${fault.code}-${String(index)}`,
      unit: unit.description,
      code: fault.code,
      status: fault.status,
      freezeFrame: unit.freezeFrames[fault.code] ?? "-",
    })),
  );
  return (
    <DataTable
      label={label}
      columns={[
        { header: "Unit", render: (row) => row.unit },
        { header: "Code", render: (row) => row.code },
        { header: "Status byte", render: (row) => row.status },
        { header: "Freeze frame", render: (row) => row.freezeFrame },
      ]}
      rows={rows}
      rowKey={(row) => row.key}
    />
  );
}
