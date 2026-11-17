import {
  decodeSharedLink,
  planDigest,
  type Storage,
  unitReportOf,
  type ObdReportShareData,
  type RunSummaryShareData,
  type ScanShareData,
  type ShareEnvelope,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { Fragment, useEffect, useRef, useState } from "react";
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
import { PlanResultView, SharedPlanView } from "./SharedPlanView";
import { keepSharedPlan } from "../guide/my-plans";
import {
  AlreadyStored,
  KIND_NAMES,
  NotSaved,
  SAVE_LABELS,
  saveShared,
  type SavedShare,
} from "./saved";

/** What a link carried: one result, or several made into one link at `createdAt`. */
type Carried =
  | { readonly kind: "single"; readonly envelope: ShareEnvelope }
  | {
      readonly kind: "bundle";
      readonly createdAt: number;
      readonly envelopes: readonly ShareEnvelope[];
    };

/** How the viewer's decoding went. */
type Decoded =
  | { readonly status: "decoding" }
  | { readonly status: "failed"; readonly message: string; readonly problems: readonly string[] }
  | { readonly status: "ready"; readonly carried: Carried };

/** Props of {@link SharedViewer}. */
export interface SharedViewerProps {
  /** The `share=...` fragment of the address. */
  readonly fragment: string;
  /** Called when the viewer is finished, with what the user saved, or undefined when nothing was. The caller clears the address. */
  readonly onDone: (saved: SavedShare | undefined) => void;
  /** Opens the Guide screen on a plan kept in My plans, ready to record; the caller clears the address. */
  readonly onOpenPlan?: (planId: string) => void;
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

/** One shared result's view, by its kind. */
function EnvelopeView({
  envelope,
  storage,
  planSaved,
  onPlanSaved,
  onOpenPlan,
  onProblem,
}: {
  readonly envelope: ShareEnvelope;
  readonly storage: Storage | undefined;
  readonly planSaved: boolean;
  readonly onPlanSaved: () => void;
  readonly onOpenPlan: ((planId: string) => void) | undefined;
  readonly onProblem: (message: string) => void;
}) {
  const keepFailed = (): void => {
    onProblem("The plan could not be kept in My plans.");
  };
  switch (envelope.kind) {
    case "scan":
      return <ScanView data={envelope.data} />;
    case "obd-report":
      return <ObdView data={envelope.data} />;
    case "run-summary":
      return <RunView data={envelope.data} />;
    case "plan":
      return (
        <SharedPlanView
          data={envelope.data}
          hash={planDigest(envelope.data.plan)}
          onOpenInGuide={
            storage === undefined || onOpenPlan === undefined
              ? undefined
              : () => void keepSharedPlan(storage, envelope.data.plan).then(onOpenPlan, keepFailed)
          }
        />
      );
    case "plan-result":
      return (
        <PlanResultView
          data={envelope.data}
          planSaved={planSaved}
          onSavePlan={
            storage === undefined
              ? undefined
              : () => void keepSharedPlan(storage, envelope.data.plan).then(onPlanSaved, keepFailed)
          }
        />
      );
    case "capture":
      return <SharedCaptureView data={envelope.data} storage={storage} />;
  }
}

/** Whether every one of `envelopes` is a capture, the only kind whose being stored is known exactly. */
function capturesOnly(envelopes: readonly ShareEnvelope[]): boolean {
  return envelopes.every((envelope) => envelope.kind === "capture");
}

/**
 * A read-only view of the result a link carries, or of each result of a link of several, one after another under its own heading, labelled as shared data that did not come from the connected adapter.
 *
 * The data is decoded and validated here and shown. By default it is then saved once, automatically, and with the setting "Save received links automatically" off it is saved only when the user presses Save, which saves every result of a link of several. Either way every kind is kept marked `origin: "shared"` ({@link saveShared}). It never goes to the diagnostics service, the guard or an adapter: this component reads the database to save and, for a capture, to read an imported profile it is decoded with.
 */
export function SharedViewer({ fragment, onDone, onOpenPlan }: SharedViewerProps) {
  const { state } = useDatabase();
  const [decoded, setDecoded] = useState<Decoded>({ status: "decoding" });
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [autoSave] = useAutoSaveShared();
  const [saved, setSaved] = useState(false);
  const [alreadySaved, setAlreadySaved] = useState(false);
  // The positions of the plan results whose plan has been kept in My plans.
  const [plansSaved, setPlansSaved] = useState<ReadonlySet<number>>(new Set());
  useActivity("saving a shared link", saving && !saved);
  // The fragment an automatic save was started for. A ref, so the second effect run React StrictMode makes in development cannot start another.
  const autoStarted = useRef<string | undefined>(undefined);

  useEffect(() => {
    const live = { active: true };
    void decodeSharedLink(fragment, streamShareCodec).then((result) => {
      if (!live.active) return;
      setDecoded(
        result.ok
          ? {
              status: "ready",
              carried:
                result.value.kind === "bundle"
                  ? {
                      kind: "bundle",
                      createdAt: result.value.createdAt,
                      envelopes: result.value.items,
                    }
                  : { kind: "single", envelope: result.value },
            }
          : {
              status: "failed",
              message: result.error.message,
              problems: result.error.code === "invalid" ? (result.error.problems ?? []) : [],
            },
      );
    });
    return () => {
      live.active = false;
    };
  }, [fragment]);

  /**
   * Saves every one of `envelopes`; true when at least one was stored and none failed, with the problem shown otherwise. One already stored is passed over and noted, so saving a link of several again stores what was not stored before.
   */
  async function store(storage: Storage, envelopes: readonly ShareEnvelope[]): Promise<boolean> {
    let stored = 0;
    for (const envelope of envelopes) {
      try {
        await saveShared(storage, envelope);
        stored += 1;
      } catch (caught) {
        if (caught instanceof AlreadyStored) {
          setAlreadySaved(true);
          continue;
        }
        setProblem(
          caught instanceof NotSaved
            ? caught.message
            : `The ${KIND_NAMES[envelope.kind]} could not be saved.`,
        );
        return false;
      }
    }
    return stored > 0;
  }

  const carried = decoded.status === "ready" ? decoded.carried : undefined;
  const envelopes =
    carried === undefined ? [] : carried.kind === "single" ? [carried.envelope] : carried.envelopes;

  async function save(): Promise<void> {
    if (state.status !== "ready") return;
    setSaving(true);
    setProblem(undefined);
    // The viewer stays open, so the person sees it saved; Dismiss then reports what was saved and clears the address.
    if (await store(state.storage, envelopes)) setSaved(true);
    setSaving(false);
  }

  const storage = state.status === "ready" ? state.storage : undefined;
  useEffect(() => {
    if (!autoSave || carried === undefined || storage === undefined) return;
    if (autoStarted.current === fragment) return;
    autoStarted.current = fragment;
    const items = carried.kind === "single" ? [carried.envelope] : carried.envelopes;
    void (async () => {
      const digest = await fragmentDigest(fragment);
      // A capture carries its own id, so whether it is stored is known exactly; every other kind relies on the remembered digest.
      const captureIds = items.flatMap((item) =>
        item.kind === "capture" ? [item.data.capture.id] : [],
      );
      const stored =
        captureIds.length === items.length
          ? (await Promise.all(captureIds.map((id) => storage.getCapture(id)))).every(
              (found) => found !== undefined,
            )
          : wasAutoSaved(digest);
      if (stored) {
        setAlreadySaved(true);
        return;
      }
      setSaving(true);
      if (await store(storage, items)) {
        recordAutoSaved(digest);
        setSaved(true);
      } else {
        setSaving(false);
      }
    })();
  }, [autoSave, fragment, carried, storage]);

  const [only] = envelopes;
  const single = carried?.kind === "single" ? carried.envelope : undefined;
  // What the save button and the notes call what the link carries.
  const what =
    single !== undefined
      ? `the ${KIND_NAMES[single.kind]}`
      : `the ${String(envelopes.length)} results`;
  const nothingNew = alreadySaved && only !== undefined && capturesOnly(envelopes);
  const unsavedNote =
    saved || alreadySaved
      ? "It never goes to the adapter."
      : autoSave && state.status === "opening"
        ? "It is saved to this device automatically, marked as shared, once the database is open. It never goes to the adapter."
        : "Nothing in it has been saved. It never goes to the adapter.";
  return (
    <div className={page}>
      <div className={heading}>
        <h1 className={headingStyle}>Shared data</h1>
        <Badge wrap tone="warning">
          From a link, not your adapter
        </Badge>
        {carried !== undefined && (
          <Badge
            wrap
          >{`Link made ${utc(carried.kind === "single" ? carried.envelope.createdAt : carried.createdAt)}`}</Badge>
        )}
        {carried?.kind === "bundle" && <Badge wrap>{`${String(envelopes.length)} results`}</Badge>}
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
        <div role="alert" className={error}>
          <p>This link cannot be opened: {decoded.message}.</p>
          {decoded.problems.length > 1 && (
            <ul aria-label="Problems in the link">
              {decoded.problems.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {envelopes.map((envelope, index) => {
        const view = (
          <EnvelopeView
            envelope={envelope}
            storage={storage}
            planSaved={plansSaved.has(index)}
            onPlanSaved={() => {
              setPlansSaved((before) => new Set(before).add(index));
            }}
            onOpenPlan={onOpenPlan}
            onProblem={setProblem}
          />
        );
        if (carried?.kind !== "bundle") return <Fragment key={index}>{view}</Fragment>;
        const name = `Result ${String(index + 1)} of ${String(envelopes.length)}: ${KIND_NAMES[envelope.kind]}`;
        return (
          <section key={index} aria-label={name} className={page}>
            <h2 className={headingStyle}>{name}</h2>
            {view}
          </section>
        );
      })}
      <div className={row}>
        {only !== undefined && (
          <Button
            variant="primary"
            disabled={state.status !== "ready" || saving || saved || nothingNew}
            onClick={() => void save()}
          >
            {saved || nothingNew
              ? "Saved"
              : alreadySaved
                ? "Save again"
                : single !== undefined
                  ? SAVE_LABELS[single.kind]
                  : `Save all ${String(envelopes.length)} results`}
          </Button>
        )}
        <Button
          onClick={() => {
            onDone(
              !saved || carried === undefined
                ? undefined
                : carried.kind === "single"
                  ? carried.envelope.kind
                  : { results: carried.envelopes.length },
            );
          }}
        >
          Dismiss
        </Button>
      </div>
      {only !== undefined && state.status !== "ready" && (
        <p className={muted}>
          {state.status === "opening"
            ? `The database is opening, so ${what} cannot be saved yet.`
            : `${what.charAt(0).toUpperCase()}${what.slice(1)} cannot be saved because ${unavailableBecause(state.problem, state.message)}.`}
        </p>
      )}
    </div>
  );
}
