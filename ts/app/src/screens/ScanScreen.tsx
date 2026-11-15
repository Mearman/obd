import { useState } from "react";
import { DiagnosticsError, type ScanResult, type UnitScan } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { useProfiles } from "../profiles/ProfilesProvider";
import { Badge, Button, Card, DataTable, Select, type Column } from "../ui";
import { error, muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const COLUMNS: readonly Column<UnitScan>[] = [
  { header: "Unit", render: (row) => row.description },
  {
    header: "Status",
    render: (row) =>
      row.responded ? (
        <Badge tone={row.faultCount > 0 ? "warning" : "success"}>
          {row.faultCount > 0 ? "Faults stored" : "No faults"}
        </Badge>
      ) : (
        <Badge>No reply</Badge>
      ),
  },
  { header: "Fault codes", render: (row) => (row.responded ? String(row.faultCount) : "-") },
];

/** Scan: choose a profile and scan its units. Wired to the simulator until the service lands. */
export function ScanScreen() {
  const { client, connection } = useDiagnostics();
  const { names } = useProfiles();
  const [profile, setProfile] = useState(names[0] ?? "");
  const [result, setResult] = useState<ScanResult | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

  async function scan(): Promise<void> {
    setScanning(true);
    setProblem(undefined);
    try {
      setResult(await client.scan(profile));
    } catch (caught) {
      setProblem(caught instanceof DiagnosticsError ? caught.message : "The scan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className={page}>
      <ScreenHeading simulated={result?.simulated === true}>Scan</ScreenHeading>
      <Card
        title="Scan the car"
        description="Reads every control unit the profile names. Scanning only reads; it never clears codes."
      >
        <Select
          label="Vehicle profile"
          value={profile}
          options={names.map((name) => ({ value: name, label: name }))}
          onValueChange={setProfile}
        />
        <Button
          variant="primary"
          block
          disabled={connection === undefined || scanning}
          onClick={() => void scan()}
        >
          {scanning ? "Scanning…" : "Start scan"}
        </Button>
        {connection === undefined && <p className={muted}>Connect an adapter first.</p>}
      </Card>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {result !== undefined && (
        <DataTable
          label={`Scan of ${result.profile}`}
          columns={COLUMNS}
          rows={result.units}
          rowKey={(row) => row.unit}
        />
      )}
    </div>
  );
}
