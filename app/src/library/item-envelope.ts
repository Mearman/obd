import {
  captureShareData,
  obdReportDocumentShareData,
  scanShareData,
  type ShareEnvelope,
  type ShareResult,
} from "obd-read";
import type { DiagnosticsClient } from "../diagnostics/client";
import type { LibraryItem, LibraryOpen } from "./items";
import { runEnvelope } from "./run-envelope";
import { isObdRead } from "./saved-report";

/** The value of a share data result, or an error carrying its message. */
function shareable<T>(result: ShareResult<T>, what: string): T {
  if (!result.ok) throw new Error(`The ${what} cannot be shared: ${result.error.message}.`);
  return result.value;
}

async function captureItemEnvelope(client: DiagnosticsClient, id: string): Promise<ShareEnvelope> {
  const capture = await client.captures.get({ id });
  const createdAt = capture.startedAt;
  return {
    v: 1,
    kind: "capture",
    createdAt,
    data: shareable(captureShareData(capture), `capture ${id}`),
  };
}

async function reportItemEnvelope(client: DiagnosticsClient, id: string): Promise<ShareEnvelope> {
  const saved = await client.reports.get({ id });
  const { report } = saved;
  const createdAt = saved.takenAt;
  return isObdRead(report)
    ? {
        v: 1,
        kind: "obd-report",
        createdAt,
        data: shareable(obdReportDocumentShareData(report), `report ${id}`),
      }
    : { v: 1, kind: "scan", createdAt, data: shareable(scanShareData(report), `report ${id}`) };
}

/**
 * The envelope that shares one Library item, read from the service when the person asks to share it and dated by the item itself, so the same item always makes the same link: a run as its plan result or summary ({@link runEnvelope}), a capture whole, and a saved report as the generic OBD-II read or the scan it holds.
 *
 * @throws Error naming the item when its data cannot be shared, as a saved report with no per-unit scan.
 */
export async function itemEnvelope(
  client: DiagnosticsClient,
  item: LibraryItem,
): Promise<ShareEnvelope> {
  switch (item.kind) {
    case "run":
      return runEnvelope(client, item.run);
    case "capture":
      return captureItemEnvelope(client, item.id);
    case "report":
      return reportItemEnvelope(client, item.id);
  }
}

/**
 * The envelope of the Library item named by `open`, read from the service by its id alone, so the address can carry the item's sharing link without the list having been read.
 *
 * @throws Error when the item is not stored on this device or cannot be shared.
 */
export async function openItemEnvelope(
  client: DiagnosticsClient,
  open: LibraryOpen,
): Promise<ShareEnvelope> {
  switch (open.kind) {
    case "run":
      return runEnvelope(client, await client.runs.get({ runId: open.id }));
    case "capture":
      return captureItemEnvelope(client, open.id);
    case "report":
      return reportItemEnvelope(client, open.id);
  }
}

/** The envelopes that share `items`, in their order, each dated by the item itself so an item makes the same link alone or in a bundle. */
export function itemEnvelopes(
  client: DiagnosticsClient,
  items: readonly LibraryItem[],
): Promise<ShareEnvelope[]> {
  return Promise.all(items.map((item) => itemEnvelope(client, item)));
}
