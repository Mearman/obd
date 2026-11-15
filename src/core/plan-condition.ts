/**
 * Evaluating a plan's conditions against what the runner observes: samples, fault code lists and the person's confirmation.
 *
 * A {@link ConditionTracker} is fed observations in time order and says, at any time, whether its condition holds and how far it has got, in words. It reads no clock of its own: every observation and every status call carries its time. This module is platform-free.
 */

import { CODE_LISTS, describeCondition, type CodeList, type PlanCondition } from "./plan.js";

/** One thing the runner saw. */
export type Observation =
  | {
      readonly type: "sample";
      readonly at: number;
      /** The first reading of each sampled value, by value name; `undefined` where it was not read. */
      readonly values: ReadonlyMap<string, number | string | undefined>;
    }
  | {
      readonly type: "codes";
      readonly at: number;
      readonly list: CodeList;
      readonly codes: readonly string[];
    }
  | { readonly type: "confirmed"; readonly at: number };

/** Where a condition stands. */
export interface ConditionStatus {
  readonly met: boolean;
  /** How far it has got, in words, such as `engine-speed 812 rpm, waiting for > 2000`. */
  readonly progress: string;
}

/** The fault code lists as last read, by list. */
export type CodeLists = ReadonlyMap<CodeList, readonly string[]>;

interface Node {
  observe(observation: Observation): void;
  status(now: number): ConditionStatus;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(0);
}

function shown(value: number | string | undefined): string {
  if (value === undefined) return "not read";
  return typeof value === "number" ? String(Number(value.toPrecision(6))) : value;
}

function holds(condition: Extract<PlanCondition, { kind: "value" }>, value: number): boolean {
  switch (condition.op) {
    case ">":
      return value > condition.than;
    case ">=":
      return value >= condition.than;
    case "<":
      return value < condition.than;
    case "<=":
      return value <= condition.than;
    case "between":
      return value >= condition.min && value <= condition.max;
    case "stable":
      return true;
  }
}

/** A value that must satisfy a comparison, on every sample for `for` seconds when given. */
function valueNode(condition: Extract<PlanCondition, { kind: "value" }>): Node {
  const goal = describeCondition(condition);
  let last: number | string | undefined;
  let lastAt: number | undefined;
  if (condition.op === "stable") {
    // The longest run of recent samples whose spread is within the tolerance.
    const window: { readonly at: number; readonly value: number }[] = [];
    return {
      observe: (observation) => {
        if (observation.type !== "sample" || !observation.values.has(condition.value)) return;
        last = observation.values.get(condition.value);
        lastAt = observation.at;
        if (typeof last !== "number") {
          window.length = 0;
          return;
        }
        window.push({ at: observation.at, value: last });
        const spread = (): number => {
          const values = window.map((entry) => entry.value);
          return Math.max(...values) - Math.min(...values);
        };
        while (window.length > 1 && spread() > condition.within) window.shift();
      },
      status: () => {
        const first = window[0];
        const steady = first === undefined || lastAt === undefined ? 0 : lastAt - first.at;
        return {
          met: steady >= condition.for * 1000,
          progress: `${condition.value} ${shown(last)}, steady ${seconds(steady)} of ${String(condition.for)} s`,
        };
      },
    };
  }
  let since: number | undefined;
  return {
    observe: (observation) => {
      if (observation.type !== "sample" || !observation.values.has(condition.value)) return;
      last = observation.values.get(condition.value);
      lastAt = observation.at;
      if (typeof last === "number" && holds(condition, last)) since ??= observation.at;
      else since = undefined;
    },
    status: () => {
      const needed = (condition.for ?? 0) * 1000;
      const held = since === undefined || lastAt === undefined ? undefined : lastAt - since;
      const met = held !== undefined && held >= needed;
      const progress =
        held === undefined || condition.for === undefined
          ? `${condition.value} ${shown(last)}, waiting for ${goal}`
          : `${condition.value} ${shown(last)}, held ${seconds(held)} of ${String(condition.for)} s`;
      return { met, progress };
    },
  };
}

function matches(
  condition: { readonly list?: CodeList | undefined; readonly code?: string | undefined },
  list: CodeList,
  code: string,
): boolean {
  return (
    (condition.list === undefined || condition.list === list) &&
    (condition.code === undefined || condition.code === code)
  );
}

/** A code that was not in its list when the wait began appears in it; once seen, it stays met. */
function appearsNode(
  condition: Extract<PlanCondition, { kind: "code-appears" }>,
  baseline: CodeLists,
): Node {
  const before = new Map(baseline);
  let found: string | undefined;
  return {
    observe: (observation) => {
      if (observation.type !== "codes" || found !== undefined) return;
      const earlier = before.get(observation.list);
      if (earlier === undefined) {
        // The first read of a list the wait began without is its baseline.
        before.set(observation.list, observation.codes);
        return;
      }
      found = observation.codes.find(
        (code) => !earlier.includes(code) && matches(condition, observation.list, code),
      );
    },
    status: () => ({
      met: found !== undefined,
      progress:
        found === undefined ? `waiting for ${describeCondition(condition)}` : `${found} appeared`,
    }),
  };
}

/** A code present when the wait began, or seen since, is gone from its list; once seen, it stays met. */
function clearsNode(
  condition: Extract<PlanCondition, { kind: "code-clears" }>,
  baseline: CodeLists,
): Node {
  const seen = new Map<CodeList, Set<string>>(
    CODE_LISTS.map((list) => [list, new Set(baseline.get(list) ?? [])]),
  );
  let cleared: string | undefined;
  return {
    observe: (observation) => {
      if (observation.type !== "codes" || cleared !== undefined) return;
      const known = seen.get(observation.list) ?? new Set<string>();
      cleared = [...known].find(
        (code) => !observation.codes.includes(code) && matches(condition, observation.list, code),
      );
      for (const code of observation.codes) known.add(code);
      seen.set(observation.list, known);
    },
    status: () => ({
      met: cleared !== undefined,
      progress:
        cleared === undefined
          ? `waiting for ${describeCondition(condition)}`
          : `${cleared} cleared`,
    }),
  };
}

function build(condition: PlanCondition, startedAt: number, baseline: CodeLists): Node {
  switch (condition.kind) {
    case "elapsed":
      return {
        observe: () => undefined,
        status: (now) => ({
          met: now - startedAt >= condition.seconds * 1000,
          progress: `${seconds(Math.min(now - startedAt, condition.seconds * 1000))} of ${String(condition.seconds)} s`,
        }),
      };
    case "samples": {
      let count = 0;
      return {
        observe: (observation) => {
          if (observation.type === "sample") count += 1;
        },
        status: () => ({
          met: count >= condition.count,
          progress: `${String(Math.min(count, condition.count))} of ${String(condition.count)} samples`,
        }),
      };
    }
    case "value":
      return valueNode(condition);
    case "code-appears":
      return appearsNode(condition, baseline);
    case "code-clears":
      return clearsNode(condition, baseline);
    case "confirm": {
      let confirmed = false;
      return {
        observe: (observation) => {
          if (observation.type === "confirmed") confirmed = true;
        },
        status: () => ({
          met: confirmed,
          progress: confirmed ? "confirmed" : `waiting for ${describeCondition(condition)}`,
        }),
      };
    }
    case "any":
    case "all": {
      const children = condition.of.map((child) => build(child, startedAt, baseline));
      return {
        observe: (observation) => {
          for (const child of children) child.observe(observation);
        },
        status: (now) => {
          const statuses = children.map((child) => child.status(now));
          const met =
            condition.kind === "any"
              ? statuses.some((status) => status.met)
              : statuses.every((status) => status.met);
          return { met, progress: statuses.map((status) => status.progress).join("; ") };
        },
      };
    }
  }
}

/** Tracks one condition from the time a wait began. */
export class ConditionTracker {
  private readonly root: Node;

  /**
   * @param startedAt When the wait began, in milliseconds since the epoch.
   * @param baseline The fault code lists as last read before the wait began; a code condition compares against them.
   */
  constructor(
    readonly condition: PlanCondition,
    startedAt: number,
    baseline: CodeLists = new Map(),
  ) {
    this.root = build(condition, startedAt, baseline);
  }

  /** Records what the runner saw. Observations come in time order. */
  observe(observation: Observation): void {
    this.root.observe(observation);
  }

  /** Whether the condition holds at `now`, and how far it has got. */
  status(now: number): ConditionStatus {
    return this.root.status(now);
  }
}

/** The prompt of the first confirmation inside `condition`, or its description when it has none. */
export function confirmPrompt(condition: PlanCondition): string | undefined {
  if (condition.kind === "confirm") return describeCondition(condition);
  if (condition.kind === "any" || condition.kind === "all") {
    for (const child of condition.of) {
      const prompt = confirmPrompt(child);
      if (prompt !== undefined) return prompt;
    }
  }
  return undefined;
}
