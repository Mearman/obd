import {
  obdReportShareData,
  scanShareFromUnits,
  type ObdScan,
  type ShareEnvelope,
  type UnitReportData,
} from "obd-read";
import { useState } from "react";
import { CaptureCard } from "../captures/CaptureCard";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Button, Card, TextField, type Column } from "../ui";
import { PROFILE_REQUIRED_REASON, profileTitle } from "../profiles/generic";
import { GuardedOperation } from "./GuardedOperation";
import { ObdReport } from "./ObdReport";
import { error, muted, page, row, stack } from "./screen.css";
import { ScanResultsTable } from "./ScanResults";
import { ScreenHeading } from "./ScreenHeading";
import { ShareDialog } from "../share/ShareDialog";

/** What a link made from a scan names besides its units. */
interface ScanDetails {
  readonly profile: string;
  readonly takenAt: number;
  readonly adapterLabel: string;
}

function shareEnvelope(units: readonly UnitReportData[], scan: ScanDetails): ShareEnvelope {
  const shared = scanShareFromUnits(units, scan);
  if (!shared.ok) throw new Error(shared.error.message);
  return { v: 1, kind: "scan", createdAt: Date.now(), data: shared.value };
}

/** The link for a generic read carries the structured OBD-II result, which holds more than the per-unit table does (readiness, current-data values, mode 06 results). */
function obdShareEnvelope(obd: ObdScan, scan: ScanDetails): ShareEnvelope {
  const shared = obdReportShareData(obd, {
    takenAt: scan.takenAt,
    adapterLabel: scan.adapterLabel,
  });
  if (!shared.ok) throw new Error(shared.error.message);
  return { v: 1, kind: "obd-report", createdAt: Date.now(), data: shared.value };
}

const REASON_ID = "profile-required-reason";

/**
 * Scan: read every unit of the connection's profile (or, with no profile, the legislated OBD-II services), capture every raw exchange, then optionally change the car in two steps.
 *
 * @param onCaptured Called with a capture's id once it is stored, to open it.
 */
export function ScanScreen({ onCaptured }: { readonly onCaptured?: (id: string) => void } = {}) {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const [units, setUnits] = useState<readonly UnitReportData[] | undefined>(undefined);
  const [obd, setObd] = useState<ObdScan | null>(null);
  const [scanned, setScanned] = useState<ScanDetails | undefined>(undefined);
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
      setScanned({
        profile: result.report.profile,
        takenAt: result.report.takenAt,
        adapterLabel: connection?.info.identity ?? "",
      });
    } catch (caught) {
      setProblem(failureMessage(caught, "The scan failed."));
    } finally {
      setScanning(false);
    }
  }

  const clearColumn: Column<UnitReportData> = {
    header: "Clear",
    render: (unit) =>
      unit.answered && (unit.faults?.length ?? 0) > 0 ? (
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
      <CaptureCard {...(onCaptured === undefined ? {} : { onSaved: onCaptured })} />
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {units !== undefined && (
        <ScanResultsTable
          label={`Scan of ${connection === undefined ? "the car" : profileTitle(connection.profile)}`}
          units={units}
          extraColumns={[clearColumn]}
        />
      )}
      {units !== undefined && scanned !== undefined && (
        <div className={row}>
          <ShareDialog
            label="Share scan"
            title="Share this scan"
            load={() =>
              Promise.resolve(
                obd === null ? shareEnvelope(units, scanned) : obdShareEnvelope(obd, scanned),
              )
            }
          />
        </div>
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
