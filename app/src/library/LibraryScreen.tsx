import {
  EXPORT_FORMATS,
  allowsWrites,
  isSimulatorUrl,
  type CaptureSummary,
  type Run,
  type ScanReport,
} from "obd-read";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CaptureViewer } from "../captures/CaptureViewer";
import { failureMessage } from "../diagnostics/client";
import { useDatabase } from "../database/DatabaseProvider";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { FaultHistory } from "../faults/FaultHistory";
import { OriginBadge } from "../origin/OriginBadge";
import { ALL_ORIGINS, ORIGIN_FILTER_OPTIONS } from "../origin/origins";
import { profileTitle } from "../profiles/generic";
import { RunGraphs } from "../screens/RunGraphs";
import { error, muted, page, row } from "../screens/screen.css";
import { ScreenHeading } from "../screens/ScreenHeading";
import { ShareDialog } from "../share/ShareDialog";
import { Badge, Button, DataTable, Dialog, Select, download, type Column } from "../ui";
import {
  ALL_KINDS,
  KIND_FILTER_OPTIONS,
  KIND_LABELS,
  emptyNote,
  itemKey,
  kindShown,
  newestFirst,
  type LibraryItem,
  type LibraryKind,
  type LibraryOpen,
} from "./items";
import { LibraryImport, useLibraryImport } from "./LibraryImport";
import { runEnvelope } from "./run-envelope";
import { SavedReportView } from "./SavedReportView";
import { useCaptureItems, useReportItems, useRunItems } from "./sources";

/** A moment as the Library shows it, in UTC so it reads the same wherever it was recorded. */
function when(at: number): string {
  return `${new Date(at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

/** `count` with the noun in the number it takes: "1 sample", "2 samples". */
function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** What the open item's viewer needs beyond its id: the run or the report read from the service. */
type Viewed = { readonly for: string } & (
  | { readonly kind: "run"; readonly run: Run }
  | { readonly kind: "report"; readonly report: ScanReport }
);

/**
 * Library: every stored run, capture and saved report in one list, newest first, filtered by kind and origin, with one import control and each kind's own viewer.
 *
 * @param open The item the viewer shows, held by the shell so it stays open when the person looks at another screen and comes back, and so another screen can open one here.
 * @param onOpen Opens an item in the viewer, or closes the viewer with undefined.
 */
export function LibraryScreen({
  open,
  onOpen,
}: {
  readonly open: LibraryOpen | undefined;
  readonly onOpen: (open: LibraryOpen | undefined) => void;
}) {
  const { service, collection, resumeCollection, stopCollection } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const [kinds, setKinds] = useState(ALL_KINDS);
  const [origins, setOrigins] = useState(ALL_ORIGINS);
  // Changes when the Library itself adds or removes an item, so every list is read again.
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [viewed, setViewed] = useState<Viewed | undefined>(undefined);
  // The open capture's origin, read from the unfiltered list so the viewer's badge never depends on the filter.
  const [captureOrigin, setCaptureOrigin] = useState<
    { readonly id: string; readonly origin: CaptureSummary["origin"] | undefined } | undefined
  >(undefined);
  const collectingId = collection.run?.id;

  const query = (kind: LibraryKind) => ({
    origin: origins,
    enabled: kindShown(kinds, kind),
    version,
  });
  const runs = useRunItems(query("run"));
  const captures = useCaptureItems(query("capture"));
  const reports = useReportItems(query("report"));
  const listings = [runs, captures, reports];
  const loaded = listings.every((listing) => listing.items !== undefined);
  const items = newestFirst(listings.map((listing) => listing.items ?? []));
  const listProblem = listings.find((listing) => listing.problem !== undefined)?.problem;

  const onImported = useCallback(
    (kind: LibraryKind, id: string) => {
      setVersion((value) => value + 1);
      if (kind === "capture") onOpen({ kind, id });
    },
    [onOpen],
  );
  const [outcome, importFile] = useLibraryImport(onImported);

  useEffect(() => {
    if (open === undefined || open.kind === "capture") return;
    const live = { active: true };
    const read =
      open.kind === "run"
        ? client.runs
            .get({ runId: open.id })
            .then((run): Viewed => ({ for: itemKey(open), kind: "run", run }))
        : client.reports
            .get({ id: open.id })
            .then((report): Viewed => ({ for: itemKey(open), kind: "report", report }));
    read.then(
      (found) => {
        if (live.active) setViewed(found);
      },
      (caught: unknown) => {
        if (live.active) setProblem(failureMessage(caught, `The ${open.kind} could not be read.`));
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, open]);

  useEffect(() => {
    if (open?.kind !== "capture") return;
    const live = { active: true };
    void client.captures.list({}).then((every) => {
      if (live.active) {
        setCaptureOrigin({
          id: open.id,
          origin: every.find((capture) => capture.id === open.id)?.origin,
        });
      }
    });
    return () => {
      live.active = false;
    };
  }, [client, open, revision, version]);

  const act = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    setProblem(undefined);
    try {
      await work();
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  }, []);

  const isOpen = (item: LibraryItem): boolean => open?.kind === item.kind && open.id === item.id;
  const close = (): void => {
    onOpen(undefined);
  };

  function details(item: LibraryItem): ReactNode {
    switch (item.kind) {
      case "run":
        return (
          <span className={row}>
            {counted(item.samples, "sample", "samples")}
            {item.run.id === collectingId ? (
              <Badge tone="success">{collection.stopping ? "Stopping…" : "Collecting"}</Badge>
            ) : item.run.stoppedAt === null ? (
              <Badge tone="warning">Open</Badge>
            ) : (
              <Badge>Stopped</Badge>
            )}
            {isSimulatorUrl(item.run.adapter) ? (
              <Badge tone="simulated">Simulated</Badge>
            ) : (
              <Badge>Recorded</Badge>
            )}
          </span>
        );
      case "capture":
        return (
          <span className={row}>
            {`${counted(item.capture.exchanges, "exchange", "exchanges")}, ${counted(item.capture.units.length, "address", "addresses")}`}
            {!item.capture.complete && <Badge tone="warning">Incomplete</Badge>}
          </span>
        );
      case "report":
        return item.report.label || "-";
    }
  }

  function actions(item: LibraryItem): ReactNode {
    switch (item.kind) {
      case "run": {
        const { run } = item;
        return (
          <span className={row}>
            {allowsWrites(run.origin) && run.stoppedAt === null && run.id !== collectingId && (
              <Button
                onClick={() => void act(() => resumeCollection(run), "Could not resume the run.")}
              >
                Resume
              </Button>
            )}
            {run.id === collectingId && (
              <Button onClick={() => void act(stopCollection, "Could not stop the run.")}>
                Stop
              </Button>
            )}
            <Button
              aria-pressed={isOpen(item)}
              onClick={() => {
                onOpen(isOpen(item) ? undefined : { kind: "run", id: run.id });
              }}
            >
              View graphs
            </Button>
            <Dialog
              trigger={<Button aria-label={`Fault codes of run ${run.id}`}>Fault codes</Button>}
              title="Fault codes"
              description="When each fault code appeared or disappeared while this run collected."
            >
              <FaultHistory client={client} runId={run.id} />
            </Dialog>
            <ShareDialog
              label="Share"
              title="Share this run's summary"
              load={() => runEnvelope(client, run)}
            />
            {EXPORT_FORMATS.map((format) => (
              <Button
                key={format}
                onClick={() =>
                  void act(async () => {
                    const file = await client.runs.export({ runId: run.id, format });
                    download(file.filename, file.mediaType, file.content);
                  }, "Could not export the run.")
                }
              >
                Export {format.toUpperCase()}
              </Button>
            ))}
          </span>
        );
      }
      case "capture":
        return (
          <span className={row}>
            <Button
              aria-label={`View capture ${item.id}`}
              onClick={() => {
                onOpen({ kind: "capture", id: item.id });
              }}
            >
              View
            </Button>
            <Button
              variant="ghost"
              aria-label={`Delete capture ${item.id}`}
              onClick={() =>
                void act(async () => {
                  await client.captures.delete({ id: item.id });
                  if (isOpen(item)) onOpen(undefined);
                  setVersion((value) => value + 1);
                }, "Could not delete the capture.")
              }
            >
              Delete
            </Button>
          </span>
        );
      case "report":
        return (
          <Button
            aria-label={`View report ${item.id}`}
            onClick={() => {
              setProblem(undefined);
              onOpen({ kind: "report", id: item.id });
            }}
          >
            View
          </Button>
        );
    }
  }

  const columns: readonly Column<LibraryItem>[] = [
    { header: "Kind", render: (item) => <Badge>{KIND_LABELS[item.kind]}</Badge> },
    { header: "Date", render: (item) => when(item.at) },
    {
      header: "Profile",
      render: (item) =>
        item.kind === "capture" && item.profile === null
          ? "no profile"
          : profileTitle(item.profile),
    },
    { header: "Details", render: details },
    { header: "Origin", render: (item) => <OriginBadge origin={item.origin} /> },
    { header: "Actions", render: actions },
  ];

  // The last item read belongs to the item it was read for, so another item reads as loading at once.
  const shownViewed = open !== undefined && viewed?.for === itemKey(open) ? viewed : undefined;

  return (
    <div
      className={page}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file !== undefined) void importFile(file);
      }}
    >
      <ScreenHeading
        simulated={items.some((item) => item.kind === "run" && isSimulatorUrl(item.run.adapter))}
      >
        Library
      </ScreenHeading>
      <p className={muted}>
        Every collection run, raw capture and saved report kept on this device, newest first. A
        capture keeps every raw request and reply, so it can be decoded with any profile, a newer
        version of one, or none; it holds the VIN and fault history. Nothing here leaves this device
        unless you export or share it.
      </p>
      <LibraryImport
        outcome={outcome}
        onFile={(file) => {
          void importFile(file);
        }}
      />
      {(problem ?? listProblem) !== undefined && (
        <p role="alert" className={error}>
          {problem ?? listProblem}
        </p>
      )}
      <div className={row}>
        <Select label="Kind" value={kinds} options={KIND_FILTER_OPTIONS} onValueChange={setKinds} />
        <Select
          label="Origin"
          value={origins}
          options={ORIGIN_FILTER_OPTIONS}
          onValueChange={setOrigins}
        />
      </div>
      {!loaded ? (
        <p className={muted}>Loading the library…</p>
      ) : items.length === 0 ? (
        <p className={muted}>{emptyNote(kinds, origins)}</p>
      ) : (
        <DataTable label="Library" columns={columns} rows={items} rowKey={itemKey} />
      )}
      {open?.kind === "capture" && (
        <CaptureViewer
          key={open.id}
          id={open.id}
          origin={captureOrigin?.id === open.id ? captureOrigin.origin : undefined}
          onClose={close}
        />
      )}
      {shownViewed?.kind === "run" && (
        <RunGraphs key={shownViewed.run.id} client={client} run={shownViewed.run} onClose={close} />
      )}
      {shownViewed?.kind === "report" && (
        <SavedReportView key={shownViewed.report.id} report={shownViewed.report} onClose={close} />
      )}
    </div>
  );
}
