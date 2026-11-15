import {
  obdReportShareData,
  scanShareFromUnits,
  type ObdScan,
  type ShareEnvelope,
  type UnitReportData,
} from "obd-read";
import { useDiagnostics } from "../../diagnostics/DiagnosticsProvider";
import { PROFILE_REQUIRED_REASON, profileTitle } from "../../profiles/generic";
import { ShareDialog } from "../../share/ShareDialog";
import { Button, Card, type Column } from "../../ui";
import { GuardedOperation } from "../GuardedOperation";
import { ObdReport } from "../ObdReport";
import { ScanResultsTable } from "../ScanResults";
import { error, muted, row } from "../screen.css";
import { useScan, type ScanDetails } from "./useScan";

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

const REASON_ID = "scan-profile-required-reason";

/**
 * The scan: reads every unit of the connection's profile (or, with no profile, the legislated OBD-II services) and shows the faults, the freeze frames and the OBD-II report, with a link to share them and each unit's guarded clear.
 *
 * @param stopRunHint Where the person stops a collection run that holds the adapter.
 */
export function ReadCard({ stopRunHint }: { readonly stopRunHint: string }) {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const { units, obd, scanned, problem, scanning, scan } = useScan();

  const idle = connection !== undefined && collection.run === undefined;
  const generic = connection?.profile === null;
  const unitActions = idle && !generic;

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
    <>
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
          <p className={muted}>A collection run holds the adapter. {stopRunHint}</p>
        )}
      </Card>
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
      {units !== undefined && generic && (
        <p id={REASON_ID} className={muted}>
          {PROFILE_REQUIRED_REASON}
        </p>
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
    </>
  );
}
