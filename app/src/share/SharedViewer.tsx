import {
  decodeShare,
  sharedScanReport,
  unitReportOf,
  type ObdReportShareData,
  type RunSummaryShareData,
  type ScanShareData,
  type ShareEnvelope,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { ObdReport } from "../screens/ObdReport";
import { FaultCodesTable, ScanResultsTable } from "../screens/ScanResults";
import { error, muted, page, row, title as headingStyle, heading } from "../screens/screen.css";
import { Badge, Button, Card, DataTable } from "../ui";
import { sparkline } from "./SharedViewer.css";

/** How the viewer's decoding went. */
type Decoded =
  | { readonly status: "decoding" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly envelope: ShareEnvelope };

/** Props of {@link SharedViewer}. */
export interface SharedViewerProps {
  /** The `share=...` fragment of the address. */
  readonly fragment: string;
  /** Called when the viewer is finished: `saved` is true when the user kept a scan. The caller clears the address. */
  readonly onDone: (saved: boolean) => void;
}

function utc(milliseconds: number): string {
  return `${new Date(milliseconds).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

function Sparkline({
  name,
  points,
}: {
  readonly name: string;
  readonly points: RunSummaryShareData["signals"][number]["series"];
}) {
  if (points.length < 2) return "-";
  const times = points.map(([time]) => time);
  const values = points.map(([, value]) => value);
  const left = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - left);
  const low = Math.min(...values);
  const range = Math.max(Number.EPSILON, Math.max(...values) - low);
  const path = points
    .map(
      ([time, value]) =>
        `${(((time - left) / span) * 100).toFixed(1)},${(30 - ((value - low) / range) * 28 - 1).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className={sparkline}
      viewBox="0 0 100 30"
      role="img"
      aria-label={`Trend of ${name}`}
      preserveAspectRatio="none"
    >
      <polyline points={path} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ScanView({ data }: { readonly data: ScanShareData }) {
  const units = data.units.map(unitReportOf);
  const identification = units.flatMap((unit) =>
    unit.identification.map((item) => ({
      key: `${unit.unit}-${item.label}`,
      unit: unit.description,
      ...item,
    })),
  );
  return (
    <>
      <Card
        title="The scan"
        description={`Profile ${data.profile.name}, taken ${data.taken}, adapter ${data.adapter.label === "" ? "unknown" : data.adapter.label}. ${data.redacted ? "The sender removed the VIN and serial numbers." : "The VIN and serial numbers are included."}`}
      />
      <ScanResultsTable label="Shared scan" units={units} />
      <FaultCodesTable label="Shared fault codes" units={units} />
      {identification.length > 0 && (
        <DataTable
          label="Shared identification"
          columns={[
            { header: "Unit", render: (item) => item.unit },
            { header: "Item", render: (item) => item.label },
            { header: "Value", render: (item) => (item.text === "" ? "removed" : item.text) },
          ]}
          rows={identification}
          rowKey={(item) => item.key}
        />
      )}
    </>
  );
}

function ObdView({ data }: { readonly data: ObdReportShareData }) {
  return (
    <>
      <Card
        title="The OBD-II read"
        description={`Read through the legislated OBD-II services with no profile, taken ${data.taken}, adapter ${data.adapter.label === "" ? "unknown" : data.adapter.label}. ${data.redacted ? "The sender removed the VIN and calibration identifiers." : "The VIN and calibration identifiers are included."}`}
      />
      <ObdReport scan={data.obd} />
    </>
  );
}

function RunView({ data }: { readonly data: RunSummaryShareData }) {
  return (
    <>
      <Card
        title="The run"
        description={`Profile ${data.run.profile}, adapter ${data.run.adapter}, started ${utc(data.run.startedAt)}, ${data.run.stoppedAt === null ? "not stopped" : `stopped ${utc(data.run.stoppedAt)}`}.${data.run.notes === "" ? "" : ` Notes: ${data.run.notes}`}`}
      />
      <DataTable
        label="Shared run signals"
        columns={[
          {
            header: "Signal",
            render: (signal) =>
              signal.unit === "" ? signal.signal : `${signal.signal} (${signal.unit})`,
          },
          { header: "Readings", render: (signal) => String(signal.count) },
          { header: "Min", render: (signal) => String(signal.min ?? "-") },
          { header: "Max", render: (signal) => String(signal.max ?? "-") },
          { header: "Mean", render: (signal) => String(signal.mean ?? "-") },
          {
            header: "Trend",
            render: (signal) => <Sparkline name={signal.signal} points={signal.series} />,
          },
        ]}
        rows={data.signals}
        rowKey={(signal) => signal.signal}
      />
    </>
  );
}

/**
 * A read-only view of the result a link carries, labelled as shared data that did not come from the connected adapter.
 *
 * The data is decoded and validated here and shown; it is never written to storage unless the user presses Save (a scan, kept as a saved scan report marked `origin: "shared"`), and it never goes to the diagnostics service, the guard or an adapter: this component reads the database only to save.
 */
export function SharedViewer({ fragment, onDone }: SharedViewerProps) {
  const { state } = useDatabase();
  const [decoded, setDecoded] = useState<Decoded>({ status: "decoding" });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const live = { active: true };
    void decodeShare(fragment, streamShareCodec).then((result) => {
      if (!live.active) return;
      setDecoded(
        result.ok
          ? { status: "ready", envelope: result.value }
          : { status: "failed", message: result.error.message },
      );
    });
    return () => {
      live.active = false;
    };
  }, [fragment]);

  async function save(envelope: ShareEnvelope & { readonly kind: "scan" }): Promise<void> {
    if (state.status !== "ready") return;
    setSaving(true);
    setProblem(undefined);
    try {
      const taken = Date.parse(envelope.data.taken);
      await state.storage.saveScanReport({
        profile: envelope.data.profile.name,
        adapter: "shared://link",
        takenAt: Number.isNaN(taken) ? envelope.createdAt : taken,
        label: "Shared scan",
        report: sharedScanReport(envelope.data),
      });
      onDone(true);
    } catch {
      setSaving(false);
      setProblem("The scan could not be saved.");
    }
  }

  const envelope = decoded.status === "ready" ? decoded.envelope : undefined;
  return (
    <div className={page}>
      <div className={heading}>
        <h1 className={headingStyle}>Shared data</h1>
        <Badge tone="warning">From a link, not your adapter</Badge>
        {envelope !== undefined && <Badge>{`Link made ${utc(envelope.createdAt)}`}</Badge>}
      </div>
      <p className={muted}>
        This is a read-only copy that someone sent you in a link. It was not read from the adapter
        you have connected, and nothing in it has been saved. It never goes to the adapter.
      </p>
      {decoded.status === "decoding" && <p className={muted}>Reading the link…</p>}
      {decoded.status === "failed" && (
        <p role="alert" className={error}>
          This link cannot be opened: {decoded.message}.
        </p>
      )}
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {envelope?.kind === "scan" && <ScanView data={envelope.data} />}
      {envelope?.kind === "obd-report" && <ObdView data={envelope.data} />}
      {envelope?.kind === "run-summary" && <RunView data={envelope.data} />}
      <div className={row}>
        {envelope?.kind === "scan" && (
          <Button
            variant="primary"
            disabled={state.status !== "ready" || saving}
            onClick={() => void save(envelope)}
          >
            Save this scan
          </Button>
        )}
        <Button
          onClick={() => {
            onDone(false);
          }}
        >
          Dismiss
        </Button>
      </div>
      {envelope?.kind === "scan" && state.status !== "ready" && (
        <p className={muted}>
          {state.status === "opening"
            ? "The database is opening, so the scan cannot be saved yet."
            : "The database is not available, so the scan cannot be saved."}
        </p>
      )}
    </div>
  );
}
