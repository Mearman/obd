/**
 * Recording plans: a JSON description of a guided recording, split into phases, each with an instruction for the person, what to sample, what to read at its start and end, and when it ends.
 *
 * A plan is data, never code. Its conditions are a small declarative vocabulary ({@link PlanCondition}) the runner evaluates against what it reads, so a plan file from anywhere is safe to load. Every wait carries a timeout and what to do when it runs out, so no plan can wait for ever, and every value a plan names is checked against the legislated value names when the plan is parsed, so a misspelt name is reported at once instead of never being read. Plans read the car only through the read-only legislated OBD-II services; there is no step that clears, writes or actuates.
 *
 * Plan files are named `*.obdplan.json`. The shipped plans live in `src/plans/`. This module is platform-free.
 */

import { z } from "zod";
import { PIDS } from "./pids.js";

/** What a plan document's `format` field holds. */
export const PLAN_FORMAT = "obd-read-plan";

/** The file name ending of a plan file. */
export const PLAN_FILE_SUFFIX = ".obdplan.json";

/** The timeout, in seconds, of a wait that does not set its own. */
export const DEFAULT_WAIT_TIMEOUT_S = 300;

/** The gap, in seconds, between samples of a phase that does not set its own. */
export const DEFAULT_SAMPLE_INTERVAL_S = 1;

/** The gap, in seconds, between reads of the fault code lists while a phase watches them. */
export const DEFAULT_CODE_WATCH_INTERVAL_S = 15;

/** The most times a phase may repeat. */
export const MAX_REPEAT = 100;

/** The fault code lists a plan can read or watch, as the legislated services name them. */
export const CODE_LISTS = ["stored", "pending", "permanent"] as const;

/** One fault code list. */
export type CodeList = (typeof CODE_LISTS)[number];

/** The reads a phase can take at its start or end, each through a read-only legislated service. */
export const PLAN_READS = [
  "stored-codes",
  "pending-codes",
  "permanent-codes",
  "freeze-frame",
  "misfire-counters",
] as const;

/** One read a phase takes at its start or end. */
export type PlanRead = (typeof PLAN_READS)[number];

/** The comparison operators of a value condition that compares against one number. */
export const COMPARISONS = [">", ">=", "<", "<="] as const;

/** A comparison of a value against one number. */
export type Comparison = (typeof COMPARISONS)[number];

/** Every legislated value name a plan may sample or test, as `live --values` takes them, sorted. */
export const PLAN_VALUE_NAMES: readonly string[] = [...PIDS.values()].map((pid) => pid.name).sort();

/**
 * A condition a plan waits for. A value condition tests the first reading of the named value (most values have only one); `for` asks for it to hold on every sample over that many seconds.
 */
export type PlanCondition =
  | { readonly kind: "elapsed"; readonly seconds: number }
  | { readonly kind: "samples"; readonly count: number }
  | {
      readonly kind: "value";
      readonly value: string;
      readonly op: Comparison;
      readonly than: number;
      readonly for?: number | undefined;
    }
  | {
      readonly kind: "value";
      readonly value: string;
      readonly op: "between";
      readonly min: number;
      readonly max: number;
      readonly for?: number | undefined;
    }
  | {
      readonly kind: "value";
      readonly value: string;
      readonly op: "stable";
      readonly within: number;
      readonly for: number;
    }
  | {
      readonly kind: "code-appears";
      readonly list?: CodeList | undefined;
      readonly code?: string | undefined;
    }
  | {
      readonly kind: "code-clears";
      readonly list?: CodeList | undefined;
      readonly code?: string | undefined;
    }
  | { readonly kind: "confirm"; readonly prompt?: string | undefined }
  | { readonly kind: "any"; readonly of: readonly PlanCondition[] }
  | { readonly kind: "all"; readonly of: readonly PlanCondition[] };

const seconds = z.number().positive();
const valueName = z.string().min(1);
const faultCode = z.string().regex(/^[PCBU][0-9A-F]{4}$/, "a fault code such as P0300");

const valueConditionSchema = z.discriminatedUnion("op", [
  z.strictObject({
    kind: z.literal("value"),
    value: valueName,
    op: z.enum(COMPARISONS),
    than: z.number(),
    for: seconds.optional(),
  }),
  z.strictObject({
    kind: z.literal("value"),
    value: valueName,
    op: z.literal("between"),
    min: z.number(),
    max: z.number(),
    for: seconds.optional(),
  }),
  z.strictObject({
    kind: z.literal("value"),
    value: valueName,
    op: z.literal("stable"),
    within: z.number().nonnegative(),
    for: seconds,
  }),
]);

/** A {@link PlanCondition}. */
export const planConditionSchema: z.ZodType<PlanCondition> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("elapsed"), seconds }),
  z.strictObject({ kind: z.literal("samples"), count: z.number().int().positive() }),
  valueConditionSchema,
  z.strictObject({
    kind: z.literal("code-appears"),
    list: z.enum(CODE_LISTS).optional(),
    code: faultCode.optional(),
  }),
  z.strictObject({
    kind: z.literal("code-clears"),
    list: z.enum(CODE_LISTS).optional(),
    code: faultCode.optional(),
  }),
  z.strictObject({ kind: z.literal("confirm"), prompt: z.string().min(1).optional() }),
  z.strictObject({
    kind: z.literal("any"),
    of: z.array(z.lazy(() => planConditionSchema)).min(1),
  }),
  z.strictObject({
    kind: z.literal("all"),
    of: z.array(z.lazy(() => planConditionSchema)).min(1),
  }),
]);

/** What happens when a wait runs out: `skip` ends the phase and carries on, `fail` ends the plan. */
export const ON_TIMEOUT = ["skip", "fail"] as const;

/** A wait: a condition, the seconds it may take and what happens when they run out. */
export const planWaitSchema = z.strictObject({
  when: planConditionSchema,
  timeout: seconds.default(DEFAULT_WAIT_TIMEOUT_S),
  onTimeout: z.enum(ON_TIMEOUT).default("fail"),
});

/** A wait with its defaults filled in. */
export type PlanWait = z.output<typeof planWaitSchema>;

/** How a phase repeats: a fixed number of times, or until a condition holds at the end of a pass, at most `max` times. */
export const planRepeatSchema = z.union([
  z.strictObject({ times: z.number().int().min(1).max(MAX_REPEAT) }),
  z.strictObject({
    until: planConditionSchema,
    max: z.number().int().min(1).max(MAX_REPEAT),
  }),
]);

/** How a phase repeats. */
export type PlanRepeat = z.output<typeof planRepeatSchema>;

const instruction = z
  .string()
  .min(1)
  .regex(/^[^\r\n]*$/, "a single line of text");

/** One phase of a plan. */
export const planPhaseSchema = z.strictObject({
  /** Unique within the plan; recorded on the phase's row. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lower case letters, digits and hyphens"),
  title: z.string().min(1),
  /** What the person does in this phase, shown when it starts. */
  instruction,
  sample: z
    .strictObject({
      /** The values to sample; omitted, every value the plan needs. */
      values: z.array(valueName).min(1).optional(),
      /** Seconds between samples, or `fastest` for one after another with no pause. */
      every: z.union([seconds, z.literal("fastest")]).default(DEFAULT_SAMPLE_INTERVAL_S),
    })
    .default({ every: DEFAULT_SAMPLE_INTERVAL_S }),
  reads: z
    .strictObject({
      start: z.array(z.enum(PLAN_READS)).default([]),
      end: z.array(z.enum(PLAN_READS)).default([]),
    })
    .default({ start: [], end: [] }),
  /** Read the fault code lists every {@link DEFAULT_CODE_WATCH_INTERVAL_S} seconds and record each change; implied by a code condition. */
  watchCodes: z.boolean().default(false),
  /** Waited for before the phase's own sampling counts towards its end. */
  start: planWaitSchema.optional(),
  end: planWaitSchema,
  repeat: planRepeatSchema.optional(),
});

/** One phase, with its defaults filled in. */
export type PlanPhase = z.output<typeof planPhaseSchema>;

const planShape = z.strictObject({
  format: z.literal(PLAN_FORMAT),
  version: z.literal(1),
  /** The plan's short name, as the CLI's `--plan` takes it. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lower case letters, digits and hyphens"),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Where the procedure comes from, or why it is shaped as it is. */
  source: z.string().min(1),
  needs: z.strictObject({
    /** The vehicle profile the run is recorded for; omitted, the generic OBD-II profile. */
    profile: z.string().min(1).optional(),
    /** The legislated values to read, or `all` for every one the car supports. */
    values: z.union([z.literal("all"), z.array(valueName).min(1)]),
  }),
  phases: z.array(planPhaseSchema).min(1),
});

/** Every condition inside `condition`, itself included. */
export function conditionsIn(condition: PlanCondition): PlanCondition[] {
  return condition.kind === "any" || condition.kind === "all"
    ? [condition, ...condition.of.flatMap(conditionsIn)]
    : [condition];
}

/** The shortest time, in seconds, `condition` can take to hold. */
export function minimumSeconds(condition: PlanCondition): number {
  switch (condition.kind) {
    case "elapsed":
      return condition.seconds;
    case "value":
      return condition.for ?? 0;
    case "any":
      return Math.min(...condition.of.map(minimumSeconds));
    case "all":
      return Math.max(...condition.of.map(minimumSeconds));
    case "samples":
    case "code-appears":
    case "code-clears":
    case "confirm":
      return 0;
  }
}

/** The values a phase samples: its own list, else the plan's, else `all`. */
export function phaseValues(
  plan: Pick<Plan, "needs">,
  phase: PlanPhase,
): readonly string[] | "all" {
  return phase.sample.values ?? plan.needs.values;
}

/** Whether a phase reads the fault code lists while it runs. */
export function watchesCodes(phase: PlanPhase): boolean {
  const waits = [phase.start?.when, phase.end.when].filter((when) => when !== undefined);
  return (
    phase.watchCodes ||
    waits
      .flatMap(conditionsIn)
      .some((condition) => condition.kind === "code-appears" || condition.kind === "code-clears")
  );
}

/** The value names a condition tests. */
function valuesTested(condition: PlanCondition): string[] {
  return conditionsIn(condition).flatMap((inner) => (inner.kind === "value" ? [inner.value] : []));
}

function unknownNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => !PLAN_VALUE_NAMES.includes(name)))];
}

/** A recording plan, with every default filled in. */
export const planSchema = planShape.superRefine((plan, context) => {
  const issue = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const unknown = (path: (string | number)[], names: readonly string[]): void => {
    const bad = unknownNames(names);
    if (bad.length > 0) {
      issue(path, `unknown value ${bad.join(", ")}; valid values: ${PLAN_VALUE_NAMES.join(", ")}`);
    }
  };
  if (plan.needs.values !== "all") unknown(["needs", "values"], plan.needs.values);
  const ids = new Set<string>();
  plan.phases.forEach((phase, index) => {
    const at = ["phases", index];
    if (ids.has(phase.id)) issue([...at, "id"], `phase id ${phase.id} is used twice`);
    ids.add(phase.id);
    if (phase.sample.values !== undefined) {
      unknown([...at, "sample", "values"], phase.sample.values);
      const needed = plan.needs.values;
      const outside =
        needed === "all" ? [] : phase.sample.values.filter((name) => !needed.includes(name));
      if (outside.length > 0) {
        issue([...at, "sample", "values"], `not in needs.values: ${outside.join(", ")}`);
      }
    }
    const sampled = phaseValues(plan, phase);
    const waits: [string, PlanWait][] = [["end", phase.end]];
    if (phase.start !== undefined) waits.push(["start", phase.start]);
    for (const [name, wait] of waits) {
      const tested = valuesTested(wait.when);
      unknown([...at, name, "when"], tested);
      // An unknown name is reported once, above, so only known names are checked here.
      const unsampled =
        sampled === "all"
          ? []
          : tested.filter((value) => PLAN_VALUE_NAMES.includes(value) && !sampled.includes(value));
      if (unsampled.length > 0) {
        issue(
          [...at, name, "when"],
          `tests values the phase does not sample: ${unsampled.join(", ")}`,
        );
      }
      const shortest = minimumSeconds(wait.when);
      if (wait.timeout <= shortest) {
        issue(
          [...at, name, "timeout"],
          `the timeout of ${String(wait.timeout)} s is not longer than the ${String(shortest)} s the condition needs`,
        );
      }
    }
    if (phase.repeat !== undefined && "until" in phase.repeat) {
      const until = phase.repeat.until;
      unknown([...at, "repeat", "until"], valuesTested(until));
      if (conditionsIn(until).some((condition) => condition.kind === "confirm")) {
        issue([...at, "repeat", "until"], "a repeat cannot wait for the person to confirm");
      }
    }
  });
});

/** A recording plan. */
export type Plan = z.output<typeof planSchema>;

/** A plan document that failed validation; the message lists every problem with its path. */
export class PlanError extends Error {
  override name = "PlanError";

  /** @param what What is wrong with the document as a whole. */
  constructor(
    readonly problems: readonly string[],
    where: string,
    what = "invalid plan",
  ) {
    super(`${where}: ${what}: ${problems.join("; ")}`);
  }
}

/**
 * Validates a parsed plan document.
 *
 * @param where Names the document in the error, such as its file name.
 * @throws PlanError listing every problem, an unknown value name with the list of valid names.
 */
export function parsePlan(data: unknown, where: string): Plan {
  const result = planSchema.safeParse(data);
  if (result.success) return result.data;
  throw new PlanError(
    result.error.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    ),
    where,
  );
}

/**
 * Parses and validates a plan file's text.
 *
 * @throws PlanError for text that is not JSON or not a valid plan.
 */
export function parsePlanText(text: string, where: string): Plan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new PlanError([error instanceof Error ? error.message : String(error)], where);
  }
  return parsePlan(data, where);
}

/** A condition in words, for a banner or a status line. */
export function describeCondition(condition: PlanCondition): string {
  const held = (text: string, duration: number | undefined): string =>
    duration === undefined ? text : `${text} for ${String(duration)} s`;
  const where = (list: CodeList | undefined): string => (list === undefined ? "" : ` (${list})`);
  switch (condition.kind) {
    case "elapsed":
      return `${String(condition.seconds)} s`;
    case "samples":
      return `${String(condition.count)} samples`;
    case "value":
      switch (condition.op) {
        case "between":
          return held(
            `${condition.value} between ${String(condition.min)} and ${String(condition.max)}`,
            condition.for,
          );
        case "stable":
          return `${condition.value} stable within ${String(condition.within)} for ${String(condition.for)} s`;
        default:
          return held(
            `${condition.value} ${condition.op} ${String(condition.than)}`,
            condition.for,
          );
      }
    case "code-appears":
      return `${condition.code ?? "a fault code"} appears${where(condition.list)}`;
    case "code-clears":
      return `${condition.code ?? "a fault code"} clears${where(condition.list)}`;
    case "confirm":
      return condition.prompt ?? "the person confirms";
    case "any":
      return condition.of.map(describeCondition).join(" or ");
    case "all":
      return condition.of.map(describeCondition).join(" and ");
  }
}
