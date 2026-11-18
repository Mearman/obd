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
import { ORIGIN_FILTER_OPTIONS } from "../origin/origins";
import { RunGraphs } from "../screens/RunGraphs";
import { error, muted, page, row } from "../screens/screen.css";
import { ScreenHeading } from "../screens/ScreenHeading";
import { ShareDialog } from "../share/ShareDialog";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  GroupedDataTable,
  Menu,
  Select,
  TextField,
  download,
  type Column,
} from "../ui";
import {
  KIND_FILTER_OPTIONS,
  KIND_LABELS,
  emptyNote,
  itemKey,
  kindShown,
  type LibraryItem,
  type LibraryKind,
  type LibraryOpen,
} from "./items";
import { itemEnvelopes } from "./item-envelope";
import { actionsRow, selectBox, vehicleCell } from "./library.css";
import { ImportNotes, LibraryImport, useLibraryImport } from "./LibraryImport";
import { runEnvelope } from "./run-envelope";
import { SavedReportView } from "./SavedReportView";
import { useSearchText } from "./useSearchText";
import { useCaptureItems, useReportItems, useRunItems } from "./sources";
import { useVehicleLabels } from "./vehicle-labels";
import {
  GROUPING_OPTIONS,
  NO_GROUPING,
  UNKNOWN_VEHICLE_LABEL,
  groupItems,
  groupingChoice,
  kindChoice,
  originChoice,
  profileText,
  shownItems,
  sortItems,
  toggleSort,
  vehicleOptions,
  vinsOf,
  type LibraryView,
  type SortColumn,
} from "./view";

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
 * Library: every stored run, capture and saved report in one list, filtered by kind, origin, vehicle (the VIN it was read from), a search and a date range, sorted by any column and optionally grouped (by kind, vehicle, origin or day), with one import control and each kind's own viewer.
 *
 * @param open The item the viewer shows, held by the shell so it stays open when the person looks at another screen and comes back, and so another screen can open one here.
 * @param onOpen Opens an item in the viewer, or closes the viewer with undefined.
 * @param view How the list is filtered, sorted and grouped, held by the shell in the address so a view has a link of its own.
 * @param onView Moves to another view, replacing the current history entry when `replace` is true.
 */
export function LibraryScreen({
  open,
  onOpen,
  view,
  onView,
}: {
  readonly open: LibraryOpen | undefined;
  readonly onOpen: (open: LibraryOpen | undefined) => void;
  readonly view: LibraryView;
  readonly onView: (view: LibraryView, replace: boolean) => void;
}) {
  const { service, collection, resumeCollection, stopCollection } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const { kind: kinds, origin: origins } = view;
  const change = (part: Partial<LibraryView>): void => {
    onView({ ...view, ...part }, false);
  };
  const search = useSearchText(view.search, (text, replace) => {
    onView({ ...view, search: text }, replace);
  });
  // Changes when the Library itself adds or removes an item, so every list is read again.
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [viewed, setViewed] = useState<Viewed | undefined>(undefined);
  // The open capture's origin, read from the unfiltered list so the viewer's badge never depends on the filter.
  const [captureOrigin, setCaptureOrigin] = useState<
    { readonly id: string; readonly origin: CaptureSummary["origin"] | undefined } | undefined
  >(undefined);
  const collectingId = collection.run?.id;
  // The rows ticked for sharing together, by item key; an item deleted or no longer stored drops out.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

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
  const stored = listings.flatMap((listing) => listing.items ?? []);
  const items = sortItems(shownItems(stored, view), view.sort);
  const labels = useVehicleLabels(vinsOf(stored));
  const listProblem = listings.find((listing) => listing.problem !== undefined)?.problem;
  // Shared in the order the list shows them, including any the search or dates hide.
  const chosen = sortItems(
    stored.filter((item) => selected.has(itemKey(item))),
    view.sort,
  );
  const select = (item: LibraryItem, ticked: boolean): void => {
    setSelected((before) => {
      const next = new Set(before);
      if (ticked) next.add(itemKey(item));
      else next.delete(itemKey(item));
      return next;
    });
  };

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
            {isSimulatorUrl(item.run.adapter) && <Badge tone="simulated">Simulated</Badge>}
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
          <span className={actionsRow}>
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
            <Dialog
              trigger={<Button aria-label={`Fault codes of run ${run.id}`}>Fault codes</Button>}
              title="Fault codes"
              description="When each fault code appeared or disappeared while this run collected."
            >
              <FaultHistory client={client} run={run} />
            </Dialog>
            <ShareDialog
              label="Share"
              title="Share this run's summary"
              load={() => runEnvelope(client, run)}
            />
            <Menu
              label="Export"
              triggerLabel={`Export run ${run.id}`}
              items={EXPORT_FORMATS.map((format) => ({
                label: format.toUpperCase(),
                onSelect: () =>
                  void act(async () => {
                    const file = await client.runs.export({ runId: run.id, format });
                    download(file.filename, file.mediaType, file.content);
                  }, "Could not export the run."),
              }))}
            />
          </span>
        );
      }
      case "capture":
        return (
          <span className={row}>
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
        return null;
    }
  }

  const columns: readonly Column<LibraryItem, SortColumn>[] = [
    {
      header: "Select",
      bare: true,
      render: (item) => (
        <input
          className={selectBox}
          type="checkbox"
          aria-label={`Select ${item.kind} ${item.id}`}
          checked={selected.has(itemKey(item))}
          onChange={(event) => {
            select(item, event.currentTarget.checked);
          }}
        />
      ),
    },
    { header: "Kind", sortKey: "kind", render: (item) => <Badge>{KIND_LABELS[item.kind]}</Badge> },
    { header: "Date", sortKey: "date", nowrap: true, render: (item) => when(item.at) },
    {
      // The vehicle shares the profile's cell, on the lines below it, so the table gains no column on a laptop.
      header: "Profile and vehicle",
      sortKeys: [
        { label: "Profile", key: "profile" },
        { label: "Vehicle", key: "vehicle" },
      ],
      nowrap: true,
      render: (item) => {
        const label = item.vin === null ? undefined : labels.get(item.vin);
        return (
          <span className={vehicleCell}>
            <span>{profileText(item)}</span>
            <span className={muted}>{item.vin ?? UNKNOWN_VEHICLE_LABEL}</span>
            {label !== undefined && <span className={muted}>{label}</span>}
          </span>
        );
      },
    },
    { header: "Details", render: details },
    {
      header: "Origin",
      sortKey: "origin",
      render: (item) => <OriginBadge origin={item.origin} />,
    },
    { header: "Actions", nowrap: true, render: actions },
  ];
  const table = {
    label: "Library",
    layout: "roomy" as const,
    columns,
    rowKey: itemKey,
    onOpen: {
      label: (item: LibraryItem) => `Open ${item.kind} ${item.id}`,
      open: (item: LibraryItem) => {
        setProblem(undefined);
        onOpen({ kind: item.kind, id: item.id });
      },
    },
    sorting: {
      key: view.sort.column,
      direction: view.sort.direction,
      onSort: (column: SortColumn) => {
        change({ sort: toggleSort(view.sort, column) });
      },
    },
  };

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
        simulated={stored.some((item) => item.kind === "run" && isSimulatorUrl(item.run.adapter))}
      >
        Library
      </ScreenHeading>
      {(problem ?? listProblem) !== undefined && (
        <p role="alert" className={error}>
          {problem ?? listProblem}
        </p>
      )}
      {open !== undefined && <ImportNotes outcome={outcome} />}
      {open === undefined && (
        <>
          <p className={muted}>
            Every collection run, raw capture and saved report kept on this device. A capture keeps
            every raw request and reply, so it can be decoded with any profile, a newer version of
            one, or none; it holds the VIN and fault history. Nothing here leaves this device unless
            you export or share it.
          </p>
          <LibraryImport
            outcome={outcome}
            onFile={(file) => {
              void importFile(file);
            }}
          />
          <div className={row}>
            <TextField
              label="Search"
              value={search.text}
              onValueChange={search.change}
              onBlur={search.end}
            />
            <Select
              label="Kind"
              value={kinds}
              options={KIND_FILTER_OPTIONS}
              onValueChange={(value) => {
                change({ kind: kindChoice(value) });
              }}
            />
            <Select
              label="Origin"
              value={origins}
              options={ORIGIN_FILTER_OPTIONS}
              onValueChange={(value) => {
                change({ origin: originChoice(value) });
              }}
            />
            <Select
              label="Vehicle"
              value={view.vehicle}
              options={vehicleOptions(stored, labels, view.vehicle)}
              onValueChange={(value) => {
                change({ vehicle: value });
              }}
            />
            <TextField
              label="From (UTC)"
              type="date"
              value={view.from ?? ""}
              onValueChange={(value) => {
                change({ from: value === "" ? undefined : value });
              }}
            />
            <TextField
              label="To (UTC)"
              type="date"
              value={view.to ?? ""}
              onValueChange={(value) => {
                change({ to: value === "" ? undefined : value });
              }}
            />
            <Select
              label="Group by"
              value={view.group ?? NO_GROUPING}
              options={GROUPING_OPTIONS}
              onValueChange={(value) => {
                change({ group: groupingChoice(value) });
              }}
            />
          </div>
          {chosen.length > 0 && (
            <div className={row} role="group" aria-label="Selected items">
              <span>{`${counted(chosen.length, "item", "items")} selected`}</span>
              <ShareDialog
                label={`Share selected (${String(chosen.length)})`}
                title={`Share ${counted(chosen.length, "result", "results")}`}
                loadAll={() => itemEnvelopes(client, chosen)}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  setSelected(new Set());
                }}
              >
                Clear selection
              </Button>
            </div>
          )}
          {!loaded ? (
            <p className={muted}>Loading the library…</p>
          ) : stored.length === 0 ? (
            <p className={muted}>{emptyNote(kinds, origins)}</p>
          ) : items.length === 0 ? (
            <p className={muted}>Nothing matches the vehicle, the search or the dates.</p>
          ) : view.group === undefined ? (
            <DataTable {...table} rows={items} />
          ) : (
            <GroupedDataTable
              {...table}
              groups={groupItems(items, view.group, view.sort, labels)}
            />
          )}
        </>
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
