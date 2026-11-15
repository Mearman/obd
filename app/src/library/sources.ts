import { useCallback, useEffect, useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDatabase } from "../database/DatabaseProvider";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { originQuery } from "../origin/origins";
import { captureItem, reportItem, runItem, type LibraryItem } from "./items";

/** What one kind's data-loading hook returns. */
export interface KindListing {
  /** The kind's items of the chosen origin, newest first; undefined until the first read finishes, and empty while the kind is filtered out. */
  readonly items: readonly LibraryItem[] | undefined;
  /** Why the last read failed, or undefined when it did not. */
  readonly problem: string | undefined;
}

/** The arguments every kind's hook takes. */
export interface KindQuery {
  /** The origin filter's value. */
  readonly origin: string;
  /** False while the kind filter hides the kind, so nothing is read for it. */
  readonly enabled: boolean;
  /** Changes whenever the Library itself may have added or removed an item, as after an import or a delete. */
  readonly version: number;
}

/**
 * Reads `load` whenever it or `refresh` changes, keeping the last result on screen until the next read finishes so the list does not flash empty.
 *
 * @param refresh Any value that changes when the stored items may have changed outside the Library's own actions.
 */
function useListing(
  load: () => Promise<readonly LibraryItem[]>,
  { enabled }: KindQuery,
  refresh: string,
  failure: string,
): KindListing {
  const [state, setState] = useState<KindListing>({ items: undefined, problem: undefined });
  useEffect(() => {
    if (!enabled) return;
    const live = { active: true };
    load().then(
      (items) => {
        if (live.active) setState({ items, problem: undefined });
      },
      (caught: unknown) => {
        if (live.active) setState({ items: [], problem: failureMessage(caught, failure) });
      },
    );
    return () => {
      live.active = false;
    };
  }, [load, enabled, refresh, failure]);
  return enabled ? state : { items: [], problem: undefined };
}

/** The stored collection runs, each with the number of samples it holds. A run listing reads again as a run collects, stops or is resumed. */
export function useRunItems(query: KindQuery): KindListing {
  const { service, runsVersion, collection } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const { origin } = query;
  const load = useCallback(async () => {
    const runs = await client.runs.list(originQuery(origin));
    return Promise.all(
      runs.map(async (run) =>
        runItem(
          run,
          (await client.runs.aggregate({ runId: run.id })).reduce(
            (total, signal) => total + signal.count,
            0,
          ),
        ),
      ),
    );
  }, [client, origin]);
  return useListing(
    load,
    query,
    `${String(runsVersion)}:${String(collection.latest.length)}:${String(revision)}:${String(query.version)}`,
    "The runs could not be read.",
  );
}

/** The stored captures, without their exchanges. */
export function useCaptureItems(query: KindQuery): KindListing {
  const { service } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const { origin } = query;
  const load = useCallback(
    async () => (await client.captures.list(originQuery(origin))).map(captureItem),
    [client, origin],
  );
  return useListing(
    load,
    query,
    `${String(revision)}:${String(query.version)}`,
    "The captures could not be read.",
  );
}

/** The saved scan reports, OBD-II reads and snapshots. */
export function useReportItems(query: KindQuery): KindListing {
  const { service } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const { origin } = query;
  const load = useCallback(
    async () => (await client.reports.list(originQuery(origin))).map(reportItem),
    [client, origin],
  );
  return useListing(
    load,
    query,
    `${String(revision)}:${String(query.version)}`,
    "The saved reports could not be read.",
  );
}
