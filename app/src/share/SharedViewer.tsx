import {
  decodeShare,
  type Storage,
  unitReportOf,
  type ObdReportShareData,
  type RunSummaryShareData,
  type ScanShareData,
  type ShareEnvelope,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect, useRef, useState } from "react";
import { unavailableBecause } from "../database/problem";
import { useDatabase } from "../database/DatabaseProvider";
import { LineChart } from "../charts";
import { useActivity } from "../pwa/ActivityProvider";
import { useAutoSaveShared } from "../settings/auto-save-shared";
import { ObdReport } from "../screens/ObdReport";
import { FaultCodesTable, ScanResultsTable } from "../screens/ScanResults";
import { error, muted, page, row, title as headingStyle, heading } from "../screens/screen.css";
import { Badge, Button, Card, DataTable } from "../ui";
import { fragmentDigest, recordAutoSaved, wasAutoSaved } from "./auto-saved";
import { SharedCaptureView } from "./SharedCaptureView";
import {
  AlreadyStored,
  KIND_NAMES,
  NotSaved,
  SAVE_LABELS,
  saveShared,
  type SavedShare,
} from "./saved";

/** How the viewer's decoding went. */
type Decoded =
  | { readonly status: "decoding" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly envelope: ShareEnvelope };

/** Props of {@link SharedViewer}. */
export interface SharedViewerProps {
  /** The `share=...` fragment of the address. */
  readonly fragment: string;
  /** Called when the viewer is finished, with what the user saved, or undefined when nothing was. The caller clears the address. */
  readonly onDone: (saved: SavedShare | undefined) => void;
}

function utc(milliseconds: number): string {
  return `${new Date(milliseconds).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

function Sparkline({
  name,
  unit,
  points,
}: {
  readonly name: string;
  readonly unit: string;
  readonly points: RunSummaryShareData["signals"][number]["series"];
}) {
  if (points.length < 2) return "-";
  return (
    <LineChart
      variant="compact"
      name={name}
      unit={unit}
      points={points.map(([t, v]) => ({ t, v }))}
    />
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
            render: (signal) => (
              <Sparkline name={signal.signal} unit={signal.unit} points={signal.series} />
            ),
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
 * The data is decoded and validated here and shown. By default it is then saved once, automatically, and with the setting "Save received links automatically" off it is saved only when the user presses Save. Either way every kind is kept marked `origin: "shared"` ({@link saveShared}). It never goes to the diagnostics service, the guard or an adapter: this component reads the database to save and, for a capture, to read an imported profile it is decoded with.
 */
export function SharedViewer({ fragment, onDone }: SharedViewerProps) {
  const { state } = useDatabase();
  const [decoded, setDecoded] = useState<Decoded>({ status: "decoding" });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [autoSave] = useAutoSaveShared();
  const [saved, setSaved] = useState(false);
  const [alreadySaved, setAlreadySaved] = useState(false);
  useActivity("saving a shared link", saving && !saved);
  // The fragment an automatic save was started for. A ref, so the second effect run React StrictMode makes in development cannot start another.
  const autoStarted = useRef<string | undefined>(undefined);

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

  /** Saves `envelope`; true when it was stored, with the problem shown otherwise. */
  async function store(storage: Storage, envelope: ShareEnvelope): Promise<boolean> {
    try {
      await saveShared(storage, envelope);
      return true;
    } catch (caught) {
      if (caught instanceof AlreadyStored) {
        setAlreadySaved(true);
        return false;
      }
      setProblem(
        caught instanceof NotSaved
          ? caught.message
          : `The ${KIND_NAMES[envelope.kind]} could not be saved.`,
      );
      return false;
    }
  }

  async function save(envelope: ShareEnvelope): Promise<void> {
    if (state.status !== "ready") return;
    setSaving(true);
    setProblem(undefined);
    // The viewer stays open, so the person sees it saved; Dismiss then reports the saved kind and clears the address.
    if (await store(state.storage, envelope)) setSaved(true);
    setSaving(false);
  }

  const readyEnvelope = decoded.status === "ready" ? decoded.envelope : undefined;
  const storage = state.status === "ready" ? state.storage : undefined;
  useEffect(() => {
    if (!autoSave || readyEnvelope === undefined || storage === undefined) return;
    if (autoStarted.current === fragment) return;
    autoStarted.current = fragment;
    void (async () => {
      const digest = await fragmentDigest(fragment);
      // A capture carries its own id, so whether it is stored is known exactly; every other kind relies on the remembered digest.
      const stored =
        readyEnvelope.kind === "capture"
          ? (await storage.getCapture(readyEnvelope.data.capture.id)) !== undefined
          : wasAutoSaved(digest);
      if (stored) {
        setAlreadySaved(true);
        return;
      }
      setSaving(true);
      if (await store(storage, readyEnvelope)) {
        recordAutoSaved(digest);
        setSaved(true);
      } else {
        setSaving(false);
      }
    })();
  }, [autoSave, fragment, readyEnvelope, storage]);

  const envelope = readyEnvelope;
  const unsavedNote = saved
    ? "It never goes to the adapter."
    : alreadySaved
      ? "It never goes to the adapter."
      : autoSave && state.status === "opening"
        ? "It is saved to this device automatically, marked as shared, once the database is open. It never goes to the adapter."
        : "Nothing in it has been saved. It never goes to the adapter.";
  return (
    <div className={page}>
      <div className={heading}>
        <h1 className={headingStyle}>Shared data</h1>
        <Badge tone="warning">From a link, not your adapter</Badge>
        {envelope !== undefined && <Badge>{`Link made ${utc(envelope.createdAt)}`}</Badge>}
      </div>
      <p className={muted}>
        This is a read-only copy that someone sent you in a link. It was not read from the adapter
        you have connected. {unsavedNote}
      </p>
      {saved && <p role="status">Saved to this device, marked as shared.</p>}
      {!saved && alreadySaved && (
        <p role="status">Already saved to this device earlier, so it was not saved again.</p>
      )}
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
      {envelope?.kind === "capture" && (
        <SharedCaptureView
          data={envelope.data}
          storage={state.status === "ready" ? state.storage : undefined}
        />
      )}
      <div className={row}>
        {envelope !== undefined && (
          <Button
            variant="primary"
            disabled={
              state.status !== "ready" ||
              saving ||
              saved ||
              (alreadySaved && envelope.kind === "capture")
            }
            onClick={() => void save(envelope)}
          >
            {saved || (alreadySaved && envelope.kind === "capture")
              ? "Saved"
              : alreadySaved
                ? "Save again"
                : SAVE_LABELS[envelope.kind]}
          </Button>
        )}
        <Button
          onClick={() => {
            onDone(saved && envelope !== undefined ? envelope.kind : undefined);
          }}
        >
          Dismiss
        </Button>
      </div>
      {envelope !== undefined && state.status !== "ready" && (
        <p className={muted}>
          {state.status === "opening"
            ? `The database is opening, so the ${KIND_NAMES[envelope.kind]} cannot be saved yet.`
            : `The ${KIND_NAMES[envelope.kind]} cannot be saved because ${unavailableBecause(state.problem, state.message)}.`}
        </p>
      )}
    </div>
  );
}
