import type { ObdScan, UnitReportData } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../../diagnostics/client";
import { useDiagnostics } from "../../diagnostics/DiagnosticsProvider";
import { useActivity } from "../../pwa/ActivityProvider";

/** What a link made from a scan names besides its units. */
export interface ScanDetails {
  readonly profile: string;
  readonly takenAt: number;
  readonly adapterLabel: string;
}

/** The latest scan of the open connection and the call that takes a new one. */
export interface ScanState {
  /** Every unit the scan read, or `undefined` before the first scan. */
  readonly units: readonly UnitReportData[] | undefined;
  /** The structured OBD-II result of a generic scan, `null` for a profile's scan. */
  readonly obd: ObdScan | null;
  readonly scanned: ScanDetails | undefined;
  /** Why the last scan failed, if it did. */
  readonly problem: string | undefined;
  readonly scanning: boolean;
  /** Reads the car again; never rejects, a failure is held in `problem`. */
  readonly scan: () => Promise<void>;
}

/** Holds one scan of the open connection: the result, the failure and whether one is running, which keeps the page from reloading while it does. */
export function useScan(): ScanState {
  const { service, connection, noteVin } = useDiagnostics();
  const [units, setUnits] = useState<readonly UnitReportData[] | undefined>(undefined);
  const [obd, setObd] = useState<ObdScan | null>(null);
  const [scanned, setScanned] = useState<ScanDetails | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  useActivity("a scan", scanning);

  async function scan(): Promise<void> {
    setScanning(true);
    setProblem(undefined);
    try {
      const result = await service.client.scan.run({});
      setUnits(result.units);
      setObd(result.obd);
      if (result.obd !== null && result.obd.vin !== null) noteVin(result.obd.vin);
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

  return { units, obd, scanned, problem, scanning, scan };
}
