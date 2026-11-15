/**
 * The plans a person keeps in the app's database ("My plans"): made in the editor, imported from a file, or saved from a plan link or a results link.
 *
 * A stored plan holds the validated plan JSON; it is parsed again with `parsePlan` whenever it is used, so a plan that no longer validates is reported, never run.
 */

import {
  jsonSchema,
  PlanError,
  parsePlan,
  planDigest,
  type Origin,
  type Plan,
  type Storage,
  type StoredPlan,
} from "obd-read";

/** A stored plan with its parsed plan, or the problems that stop it parsing. */
export type KeptPlan =
  | { readonly stored: StoredPlan; readonly plan: Plan; readonly problems?: undefined }
  | {
      readonly stored: StoredPlan;
      readonly plan?: undefined;
      readonly problems: readonly string[];
    };

/** Parses a stored plan's document. */
export function keptPlan(stored: StoredPlan): KeptPlan {
  try {
    return { stored, plan: parsePlan(stored.document, stored.title) };
  } catch (caught) {
    if (caught instanceof PlanError) return { stored, problems: caught.problems };
    throw caught;
  }
}

/** The id a plan from a link is kept under: the same plan saved twice from links is one entry, a changed one another. */
export function sharedPlanId(plan: Plan): string {
  return `shared-${planDigest(plan).slice(0, 16)}`;
}

/** A new id for a plan made or imported here. */
export function newPlanId(): string {
  return `local-${crypto.randomUUID()}`;
}

/** The plan as the JSON a stored plan holds. */
function documentOf(plan: Plan): StoredPlan["document"] {
  return jsonSchema.parse(JSON.parse(JSON.stringify(plan)));
}

/** Stores `plan` under `id` with where it came from, and returns what was stored. */
export async function keepPlan(
  storage: Storage,
  plan: Plan,
  origin: Origin,
  id: string,
): Promise<StoredPlan> {
  const stored: StoredPlan = {
    id,
    name: plan.name,
    title: plan.title,
    revision: plan.revision ?? 1,
    origin,
    updatedAt: Date.now(),
    document: documentOf(plan),
  };
  await storage.savePlan(stored);
  return stored;
}

/** Saves a plan that came in a link, marked as shared, and returns its id. */
export async function keepSharedPlan(storage: Storage, plan: Plan): Promise<string> {
  const id = sharedPlanId(plan);
  await keepPlan(storage, plan, "shared", id);
  return id;
}

/** The file name a plan is exported under. */
export function planFileName(plan: Plan): string {
  return `${plan.name}.obdplan.json`;
}

/** The plan as the text of its file. */
export function planFileText(plan: Plan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
