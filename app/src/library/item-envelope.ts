import {
  captureShareData,
  obdReportDocumentShareData,
  scanShareData,
  type ShareEnvelope,
  type ShareResult,
} from "obd-read";
import type { DiagnosticsClient } from "../diagnostics/client";
import type { LibraryItem } from "./items";
import { runEnvelope } from "./run-envelope";
import { isObdRead } from "./saved-report";

/** The value of a share data result, or an error carrying its message. */
function shareable<T>(result: ShareResult<T>, what: string): T {
  if (!result.ok) throw new Error(`The ${what} cannot be shared: ${result.error.message}.`);
  return result.value;
}

/**
 * The envelope that shares one Library item, read from the service when the person asks to share it: a run as its plan result or summary ({@link runEnvelope}), a capture whole, and a saved report as the generic OBD-II read or the scan it holds.
 *
 * @throws Error naming the item when its data cannot be shared, as a saved report with no per-unit scan.
 */
export async function itemEnvelope(
  client: DiagnosticsClient,
  item: LibraryItem,
  createdAt: number,
): Promise<ShareEnvelope> {
  switch (item.kind) {
    case "run":
      return { ...(await runEnvelope(client, item.run)), createdAt };
    case "capture": {
      const capture = await client.captures.get({ id: item.id });
      return {
        v: 1,
        kind: "capture",
        createdAt,
        data: shareable(captureShareData(capture), `capture ${item.id}`),
      };
    }
    case "report": {
      const { report } = await client.reports.get({ id: item.id });
      return isObdRead(report)
        ? {
            v: 1,
            kind: "obd-report",
            createdAt,
            data: shareable(obdReportDocumentShareData(report), `report ${item.id}`),
          }
        : {
            v: 1,
            kind: "scan",
            createdAt,
            data: shareable(scanShareData(report), `report ${item.id}`),
          };
    }
  }
}

/** The envelopes that share `items`, in their order, all made at the same moment. */
export function itemEnvelopes(
  client: DiagnosticsClient,
  items: readonly LibraryItem[],
): Promise<ShareEnvelope[]> {
  const createdAt = Date.now();
  return Promise.all(items.map((item) => itemEnvelope(client, item, createdAt)));
}
