import { keepSharedPlan } from "../guide/my-plans";
import {
  GENERIC_PROFILE,
  sharedObdReportDocument,
  sharedRunSamples,
  sharedRunStop,
  sharedPlanResultSamples,
  sharedScanReport,
  type ShareEnvelope,
  type Storage,
} from "obd-read";

/** What a shared link's viewer saved: the kind of a link of one result, or how many results a link of several carried. */
export type SavedShare = ShareEnvelope["kind"] | { readonly results: number };

/** The Save button's label for each kind. */
export const SAVE_LABELS: Readonly<Record<ShareEnvelope["kind"], string>> = {
  scan: "Save this scan",
  "obd-report": "Save this read",
  "run-summary": "Save this run",
  capture: "Save this capture",
  plan: "Save to my plans",
  "plan-result": "Save these results",
};

/** What each kind is called in a sentence. */
export const KIND_NAMES: Readonly<Record<ShareEnvelope["kind"], string>> = {
  scan: "scan",
  "obd-report": "OBD-II read",
  "run-summary": "run",
  capture: "capture",
  plan: "plan",
  "plan-result": "plan result",
};

/** The notice shown once a shared item is saved. */
export const SAVED_NOTICES: Readonly<
  Record<ShareEnvelope["kind"], { readonly title: string; readonly description: string }>
> = {
  scan: {
    title: "Saved the shared scan",
    description: "It is stored with your saved reports, marked as shared.",
  },
  "obd-report": {
    title: "Saved the shared OBD-II read",
    description: "It is stored with your saved reports, marked as shared.",
  },
  "run-summary": {
    title: "Saved the shared run",
    description:
      "It is stored with your runs, marked as shared, with the readings the link carried. It cannot be resumed.",
  },
  capture: {
    title: "Saved the shared capture",
    description: "It is stored with your captures, marked as shared.",
  },
  plan: {
    title: "Saved the shared plan",
    description: "It is in My plans on the Guide screen, marked as shared.",
  },
  "plan-result": {
    title: "Saved the shared plan result",
    description:
      "It is stored with your runs, marked as shared, with its phases, codes and the readings the link carried.",
  },
};

/** The notice shown once what a link carried is saved: the kind's own for one result, one for several. */
export function savedNotice(saved: SavedShare): {
  readonly title: string;
  readonly description: string;
} {
  return typeof saved === "string"
    ? SAVED_NOTICES[saved]
    : {
        title: `Saved the ${String(saved.results)} shared results`,
        description:
          "Each is stored with its own kind (saved reports, runs, captures or My plans), marked as shared.",
      };
}

/** The item a link carries is already stored on this device, so saving it again would only duplicate it (or, for a capture with the same id, is refused). */
export class AlreadyStored extends Error {
  override name = "AlreadyStored";
}

/** A shared item could not be saved for a reason the user can read. */
export class NotSaved extends Error {
  override name = "NotSaved";
}

/** When a shared result was taken: the time it records, or when the link was made if that does not read as a time. */
function takenAt(taken: string, createdAt: number): number {
  const parsed = Date.parse(taken);
  return Number.isNaN(parsed) ? createdAt : parsed;
}

/**
 * Stores what a link carries, marked `origin: "shared"`: a scan or an OBD-II read as a saved report, a run summary as a stopped run holding the readings the link carries, a capture as a capture, a plan in My plans and a plan result as a stopped plan run with its plan, phases and codes. Called only when the user presses Save.
 *
 * @throws NotSaved for a capture whose id is stored already.
 */
export async function saveShared(storage: Storage, envelope: ShareEnvelope): Promise<void> {
  switch (envelope.kind) {
    case "scan":
      await storage.saveScanReport({
        profile: envelope.data.profile.name,
        adapter: "shared://link",
        takenAt: takenAt(envelope.data.taken, envelope.createdAt),
        label: "Shared scan",
        report: sharedScanReport(envelope.data),
        origin: "shared",
      });
      return;
    case "obd-report":
      await storage.saveScanReport({
        profile: GENERIC_PROFILE,
        adapter: "shared://link",
        takenAt: takenAt(envelope.data.taken, envelope.createdAt),
        label: "Shared OBD-II read",
        report: sharedObdReportDocument(envelope.data),
        origin: "shared",
      });
      return;
    case "run-summary": {
      const { run } = envelope.data;
      const created = await storage.createRun({
        profile: run.profile,
        adapter: run.adapter,
        startedAt: run.startedAt,
        notes: run.notes,
        origin: "shared",
      });
      await storage.appendSamples(sharedRunSamples(envelope.data, created.id));
      await storage.stopRun(created.id, sharedRunStop(envelope.data));
      return;
    }
    case "plan":
      await keepSharedPlan(storage, envelope.data.plan);
      return;
    case "plan-result": {
      const { run } = envelope.data.run;
      const created = await storage.createRun({
        profile: run.profile,
        adapter: run.adapter,
        startedAt: run.startedAt,
        notes: run.notes,
        origin: "shared",
      });
      await storage.appendSamples(sharedPlanResultSamples(envelope.data, created.id));
      await storage.stopRun(created.id, sharedRunStop(envelope.data.run));
      return;
    }
    case "capture":
      if ((await storage.getCapture(envelope.data.capture.id)) !== undefined) {
        throw new AlreadyStored(
          `A capture with the id ${envelope.data.capture.id} is already stored on this device.`,
        );
      }
      await storage.saveCapture(envelope.data.capture, { origin: "shared", vin: null, plate: null });
      return;
  }
}
