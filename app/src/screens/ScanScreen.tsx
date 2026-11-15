import type { ObdScan, UnitReportData } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Badge, Button, Card, DataTable, TextField, type Column } from "../ui";
import { PROFILE_REQUIRED_REASON, profileTitle } from "../profiles/generic";
import { GuardedOperation } from "./GuardedOperation";
import { ObdReport } from "./ObdReport";
import { error, muted, page, row, stack } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

function faultCount(unit: UnitReportData): number {
  return unit.faults?.length ?? 0;
}

const REASON_ID = "profile-required-reason";

/** Scan: read every unit of the connection's profile (or, with no profile, the legislated OBD-II services), then optionally change the car in two steps. */
export function ScanScreen() {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const [units, setUnits] = useState<readonly UnitReportData[] | undefined>(undefined);
  const [obd, setObd] = useState<ObdScan | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [writeUnit, setWriteUnit] = useState("engine");
  const [writeRequest, setWriteRequest] = useState("");
  const [writeRead, setWriteRead] = useState("");
  const [actuateRequest, setActuateRequest] = useState("");
  const [actuateStop, setActuateStop] = useState("");
  const [actuateMs, setActuateMs] = useState("1000");

  const idle = connection !== undefined && collection.run === undefined;
  const generic = connection?.profile === null;
  const unitActions = idle && !generic;

  async function scan(): Promise<void> {
    setScanning(true);
    setProblem(undefined);
    try {
      const result = await client.scan.run({});
      setUnits(result.units);
      setObd(result.obd);
    } catch (caught) {
      setProblem(failureMessage(caught, "The scan failed."));
    } finally {
      setScanning(false);
    }
  }

  const clearColumn: Column<UnitReportData> = {
    header: "Clear",
    render: (unit) =>
      unit.answered && faultCount(unit) > 0 ? (
        <GuardedOperation
          label={`Clear ${unit.unit} codes`}
          title={`Clear fault codes from ${unit.description}`}
          disabled={!unitActions}
          describedBy={generic ? REASON_ID : undefined}
          request={() => client.clear.request({ target: { kind: "unit", unit: unit.unit } })}
          confirm={(confirmation) => client.clear.confirm({ confirmation })}
          onDone={() => void scan()}
        />
      ) : (
        "-"
      ),
  };

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
    clearColumn,
  ];

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Scan</ScreenHeading>
      <Card
        title="Scan the car"
        description={
          generic
            ? "Reads the legislated OBD-II services, which need no profile. Scanning only reads; it never clears codes."
            : `Reads every control unit the ${connection?.profile ?? "connection's"} profile names. Scanning only reads; it never clears codes.`
        }
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
          label={`Scan of ${connection === undefined ? "the car" : profileTitle(connection.profile)}`}
          columns={columns}
          rows={units}
          rowKey={(unit) => unit.unit}
        />
      )}
      {obd !== null && <ObdReport scan={obd} />}

      <Card
        title="Changes to the car"
        description="Each one is two steps. The first reads the car, saves a snapshot and shows exactly what would be sent. Only the second sends it, through the read-only guard's single-use permission."
      >
        <div className={stack}>
          {generic && (
            <p id={REASON_ID} className={muted}>
              {PROFILE_REQUIRED_REASON} Clearing every emissions code below needs no profile.
            </p>
          )}
          <GuardedOperation
            label="Clear every emissions code (mode 04)"
            title="Clear emissions codes on every unit"
            disabled={!idle}
            request={() => client.clear.request({ target: { kind: "obd" } })}
            confirm={(confirmation) => client.clear.confirm({ confirmation })}
          />
          <TextField
            label="Unit to change"
            value={writeUnit}
            onValueChange={setWriteUnit}
            disabled={generic}
          />
          <TextField
            label="Write request (hexadecimal)"
            value={writeRequest}
            onValueChange={setWriteRequest}
            placeholder="3B 99 00 02"
            disabled={generic}
          />
          <TextField
            label="Read request for the same value"
            value={writeRead}
            onValueChange={setWriteRead}
            placeholder="21 99"
            disabled={generic}
          />
          <div className={row}>
            <GuardedOperation
              label="Write a value"
              title="Write a value"
              disabled={!unitActions || writeRequest === "" || writeRead === ""}
              describedBy={generic ? REASON_ID : undefined}
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
            disabled={generic}
          />
          <TextField
            label="Actuator stop request (hexadecimal)"
            value={actuateStop}
            onValueChange={setActuateStop}
            placeholder="30 20 00"
            disabled={generic}
          />
          <TextField
            label="Hold for (milliseconds, at most 30000)"
            value={actuateMs}
            onValueChange={setActuateMs}
            inputMode="numeric"
            disabled={generic}
          />
          <div className={row}>
            <GuardedOperation
              label="Run an actuator test"
              title="Run an actuator test"
              disabled={!unitActions || actuateRequest === "" || actuateStop === ""}
              describedBy={generic ? REASON_ID : undefined}
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
