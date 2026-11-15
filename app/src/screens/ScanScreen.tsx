import type { UnitReportData } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Badge, Button, Card, DataTable, TextField, type Column } from "../ui";
import { GuardedOperation } from "./GuardedOperation";
import { error, muted, page, row, stack } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

function faultCount(unit: UnitReportData): number {
  return unit.faults?.length ?? 0;
}

/** Scan: read every unit of the connection's profile, then optionally change the car in two steps. */
export function ScanScreen() {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const [units, setUnits] = useState<readonly UnitReportData[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [writeUnit, setWriteUnit] = useState("engine");
  const [writeRequest, setWriteRequest] = useState("");
  const [writeRead, setWriteRead] = useState("");
  const [actuateRequest, setActuateRequest] = useState("");
  const [actuateStop, setActuateStop] = useState("");
  const [actuateMs, setActuateMs] = useState("1000");

  const idle = connection !== undefined && collection.run === undefined;

  async function scan(): Promise<void> {
    setScanning(true);
    setProblem(undefined);
    try {
      setUnits((await client.scan.run({})).units);
    } catch (caught) {
      setProblem(failureMessage(caught, "The scan failed."));
    } finally {
      setScanning(false);
    }
  }

  const columns: readonly Column<UnitReportData>[] = [
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
    {
      header: "Clear",
      render: (unit) =>
        unit.answered && faultCount(unit) > 0 ? (
          <GuardedOperation
            label={`Clear ${unit.unit} codes`}
            title={`Clear fault codes from ${unit.description}`}
            disabled={!idle}
            request={() => client.clear.request({ target: { kind: "unit", unit: unit.unit } })}
            confirm={(confirmation) => client.clear.confirm({ confirmation })}
            onDone={() => void scan()}
          />
        ) : (
          "-"
        ),
    },
  ];

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Scan</ScreenHeading>
      <Card
        title="Scan the car"
        description={`Reads every control unit the ${connection?.profile ?? "connection's"} profile names. Scanning only reads; it never clears codes.`}
      >
        <Button variant="primary" block disabled={!idle || scanning} onClick={() => void scan()}>
          {scanning ? "Scanning…" : "Start scan"}
        </Button>
        {connection === undefined && <p className={muted}>Connect an adapter first.</p>}
        {collection.run !== undefined && (
          <p className={muted}>A collection run holds the adapter. Stop it on the Live screen.</p>
        )}
      </Card>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {units !== undefined && (
        <DataTable
          label={`Scan of ${connection?.profile ?? "the car"}`}
          columns={columns}
          rows={units}
          rowKey={(unit) => unit.unit}
        />
      )}

      <Card
        title="Changes to the car"
        description="Each one is two steps. The first reads the car, saves a snapshot and shows exactly what would be sent. Only the second sends it, through the read-only guard's single-use permission."
      >
        <div className={stack}>
          <GuardedOperation
            label="Clear every emissions code (mode 04)"
            title="Clear emissions codes on every unit"
            disabled={!idle}
            request={() => client.clear.request({ target: { kind: "obd" } })}
            confirm={(confirmation) => client.clear.confirm({ confirmation })}
          />
          <TextField label="Unit to change" value={writeUnit} onValueChange={setWriteUnit} />
          <TextField
            label="Write request (hexadecimal)"
            value={writeRequest}
            onValueChange={setWriteRequest}
            placeholder="3B 99 00 02"
          />
          <TextField
            label="Read request for the same value"
            value={writeRead}
            onValueChange={setWriteRead}
            placeholder="21 99"
          />
          <div className={row}>
            <GuardedOperation
              label="Write a value"
              title="Write a value"
              disabled={!idle || writeRequest === "" || writeRead === ""}
              request={() =>
                client.write.request({ unit: writeUnit, request: writeRequest, read: writeRead })
              }
              confirm={(confirmation) => client.write.confirm({ confirmation })}
            />
          </div>
          <TextField
            label="Actuator start request (hexadecimal)"
            value={actuateRequest}
            onValueChange={setActuateRequest}
            placeholder="30 20 07 01"
          />
          <TextField
            label="Actuator stop request (hexadecimal)"
            value={actuateStop}
            onValueChange={setActuateStop}
            placeholder="30 20 00"
          />
          <TextField
            label="Hold for (milliseconds, at most 30000)"
            value={actuateMs}
            onValueChange={setActuateMs}
            inputMode="numeric"
          />
          <div className={row}>
            <GuardedOperation
              label="Run an actuator test"
              title="Run an actuator test"
              disabled={!idle || actuateRequest === "" || actuateStop === ""}
              request={() =>
                client.actuate.request({
                  unit: writeUnit,
                  request: actuateRequest,
                  stop: actuateStop,
                  durationMs: Number(actuateMs),
                })
              }
              confirm={(confirmation) => client.actuate.confirm({ confirmation })}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
