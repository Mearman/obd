import { decodeShare, type ShareEnvelope } from "obd-read";
import { streamShareCodec } from "obd-read/web";
import type { DiagnosticsClient } from "../diagnostics/client";
import { openItemEnvelope } from "./item-envelope";
import type { LibraryOpen } from "./items";

/**
 * The Library item a share link carries, when this device stores it, so one link opens the item here and the read-only viewer elsewhere. A capture is the one with the same id, a run the one started at the same moment under the same profile, and a saved report the one taken at the same time with the same kind of data; nothing is compared beyond that, so a link to a run still collecting opens the run as it is now.
 *
 * @returns The stored item, or undefined for a link to anything else: another device's data, a bundle, a plan, or a link that cannot be read.
 */
export async function findStoredItem(
  client: DiagnosticsClient,
  fragment: string,
): Promise<LibraryOpen | undefined> {
  const decoded = await decodeShare(fragment, streamShareCodec);
  if (!decoded.ok) return undefined;
  const link = decoded.value;
  switch (link.kind) {
    case "capture": {
      const id = link.data.capture.id;
      return (await client.captures.list({})).some((capture) => capture.id === id)
        ? { kind: "capture", id }
        : undefined;
    }
    case "run-summary":
      return runStartedAt(client, link.data.run.startedAt, link.data.run.profile);
    case "plan-result":
      return runStartedAt(client, link.data.run.run.startedAt, link.data.run.run.profile);
    case "scan":
    case "obd-report":
      return reportTaken(client, link);
    case "plan":
      return undefined;
  }
}

async function runStartedAt(
  client: DiagnosticsClient,
  startedAt: number,
  profile: string,
): Promise<LibraryOpen | undefined> {
  const run = (await client.runs.list({})).find(
    (candidate) => candidate.startedAt === startedAt && candidate.profile === profile,
  );
  return run === undefined ? undefined : { kind: "run", id: run.id };
}

async function reportTaken(
  client: DiagnosticsClient,
  link: Extract<ShareEnvelope, { kind: "scan" | "obd-report" }>,
): Promise<LibraryOpen | undefined> {
  for (const summary of await client.reports.list({})) {
    const open: LibraryOpen = { kind: "report", id: summary.id };
    const stored = await openItemEnvelope(client, open).catch(() => undefined);
    if (stored?.kind === link.kind && stored.data.taken === link.data.taken) return open;
  }
  return undefined;
}
