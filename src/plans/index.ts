/**
 * The recording plans shipped with the package, as a registry that works in Node and in the browser.
 *
 * The JSON files are imported rather than read, so a bundler includes them and no file access is needed. A plan from anywhere else (a file the user picks) goes through `parsePlan` in core.
 */

import { pythonRepr } from "../core/format.js";
import { PlanError, parsePlan, type Plan } from "../core/plan.js";
import coldStartWarmUp from "./cold-start-warm-up.obdplan.json" with { type: "json" };
import driveCycleWatch from "./drive-cycle-watch.obdplan.json" with { type: "json" };
import idleThenRev from "./idle-then-rev.obdplan.json" with { type: "json" };
import misfireUnderLoad from "./misfire-under-load.obdplan.json" with { type: "json" };

const SHIPPED: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["cold-start-warm-up", coldStartWarmUp],
  ["drive-cycle-watch", driveCycleWatch],
  ["idle-then-rev", idleThenRev],
  ["misfire-under-load", misfireUnderLoad],
]);

/** Names of the plans shipped with the package, sorted. */
export function builtinPlans(): string[] {
  return [...SHIPPED.keys()].sort();
}

/**
 * The parsed JSON of a shipped plan, unvalidated, as `parsePlan` takes it.
 *
 * @throws PlanError listing the shipped names when there is no such plan.
 */
export function builtinPlanData(name: string): unknown {
  if (!SHIPPED.has(name)) {
    throw new PlanError(
      [`shipped plans: ${builtinPlans().join(", ")}`],
      pythonRepr(name),
      "no such plan",
    );
  }
  return SHIPPED.get(name);
}

/**
 * Loads a shipped plan by name.
 *
 * @throws PlanError when there is no such plan or it is invalid.
 */
export function loadBuiltinPlan(name: string): Plan {
  return parsePlan(builtinPlanData(name), name);
}
