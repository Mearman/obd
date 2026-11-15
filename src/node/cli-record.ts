/**
 * The `record` and `plan` commands: run a recording plan on an open adapter session and write the run, or list, show and validate plans without connecting.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Elm } from "../core/elm.js";
import { OptionError } from "../core/options.js";
import { confirmPrompt } from "../core/plan-condition.js";
import {
  PLAN_FILE_SUFFIX,
  PlanError,
  describePlanVersion,
  planIdentity,
  parsePlan,
  parsePlanText,
  type Plan,
} from "../core/plan.js";
import {
  PlanRunner,
  type PlanEvent,
  type PlanResult,
  type ReadResult,
} from "../core/plan-runner.js";
import { exportRunDelimitedText, exportRunJson } from "../core/run-export.js";
import {
  decodeShare,
  describeLinkLength,
  encodeShare,
  fragmentOfLink,
  shareLink,
} from "../core/share.js";
import { describePlan, planEnvelope } from "../core/share-plan.js";
import { zlibShareCodec } from "./share-codec.js";

/** The app's address a plan link points at unless `--base` gives another. */
const DEFAULT_APP_ADDRESS = "https://mearman.github.io/obd/";

export { describePlan } from "../core/share-plan.js";
import type { Dialect } from "../core/tabular.js";
import { MemoryStorage } from "../core/testing/memory-storage.js";
import type { LineSink } from "../core/unit-access.js";
import { builtinPlanData, builtinPlans, loadBuiltinPlan } from "../plans/index.js";
import { fileErrorText, writeNewFile } from "./cli-files.js";

/** What the plan commands take from the command line's surroundings. */
export interface PlanIo {
  readonly out: LineSink;
  /** Writes text with no line break of its own; the live status line is drawn on it. */
  readonly err: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly directory: string;
  /** Whether a person at a terminal can answer prompts and watch a status line redrawn in place. */
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
}

async function exists(directory: string, path: string): Promise<boolean> {
  try {
    await stat(resolve(directory, path));
    return true;
  } catch {
    return false;
  }
}

/**
 * A shipped plan by name, or a plan file by path.
 *
 * @throws PlanError when there is no such plan, the file cannot be read or the plan is invalid.
 */
export async function loadPlan(directory: string, nameOrPath: string): Promise<Plan> {
  if (!nameOrPath.endsWith(".json") && !(await exists(directory, nameOrPath))) {
    return loadBuiltinPlan(nameOrPath);
  }
  let text: string;
  try {
    text = await readFile(resolve(directory, nameOrPath), "utf8");
  } catch (error) {
    throw new PlanError([fileErrorText(error, nameOrPath)], nameOrPath, "cannot read the plan");
  }
  return parsePlanText(text, nameOrPath);
}

/** Whether any wait of the plan asks the person to confirm. */
export function asksToConfirm(plan: Plan): boolean {
  return plan.phases.some((phase) =>
    [phase.start?.when, phase.end.when].some(
      (when) => when !== undefined && confirmPrompt(when) !== undefined,
    ),
  );
}

/**
 * Runs `plan list`, `plan show` or `plan validate`.
 *
 * @returns 0, or 1 when `validate` found an invalid plan.
 * @throws PlanError for a plan `show` cannot load.
 */
export async function planCommand(
  io: PlanIo,
  subcommand: string,
  targets: readonly string[],
  options: { readonly base?: string | undefined; readonly output?: string | undefined } = {},
): Promise<number> {
  switch (subcommand) {
    case "share": {
      const [target] = targets;
      if (target === undefined) throw new OptionError("name a plan to share");
      const plan = await loadPlan(io.directory, target);
      const encoded = await encodeShare(planEnvelope(plan, Date.now()), zlibShareCodec);
      if (!encoded.ok)
        throw new PlanError([encoded.error.message], target, "cannot share the plan");
      const link = shareLink(options.base ?? DEFAULT_APP_ADDRESS, encoded.value.fragment);
      io.out(link);
      io.err(`${describePlanVersion(planIdentity(plan))}; ${describeLinkLength(link.length)}\n`);
      return 0;
    }
    case "import": {
      const [link] = targets;
      if (link === undefined) throw new OptionError("give a plan link to import");
      const fragment = fragmentOfLink(link);
      if (fragment === undefined) {
        throw new PlanError(["it has no #share= fragment"], "link", "not a share link");
      }
      const decoded = await decodeShare(fragment, zlibShareCodec);
      if (!decoded.ok) {
        const { error } = decoded;
        throw new PlanError(
          error.code === "invalid" && error.problems !== undefined
            ? error.problems
            : [error.message],
          "link",
          "cannot read the link",
        );
      }
      const envelope = decoded.value;
      if (envelope.kind !== "plan" && envelope.kind !== "plan-result") {
        throw new PlanError([`it carries a ${envelope.kind}`], "link", "not a plan link");
      }
      const plan = envelope.data.plan;
      const output = options.output ?? `${plan.name}${PLAN_FILE_SUFFIX}`;
      try {
        await writeNewFile(
          io.directory,
          output,
          new TextEncoder().encode(`${JSON.stringify(plan, null, 2)}\n`),
        );
      } catch (error) {
        throw new PlanError([fileErrorText(error, output)], output, "cannot write the plan");
      }
      io.out(`wrote ${output}: ${plan.name}, ${describePlanVersion(planIdentity(plan))}`);
      return 0;
    }
    case "list":
      for (const name of builtinPlans()) {
        io.out(`${name}: ${parsePlan(builtinPlanData(name), name).title}`);
      }
      return 0;
    case "show": {
      const [target] = targets;
      if (target === undefined) throw new OptionError("name a plan to show");
      for (const line of describePlan(await loadPlan(io.directory, target))) io.out(line);
      return 0;
    }
    case "validate": {
      let status = 0;
      for (const target of targets) {
        try {
          const plan = await loadPlan(io.directory, target);
          io.out(`${target}: valid plan ${plan.name}, ${String(plan.phases.length)} phases`);
        } catch (error) {
          if (!(error instanceof PlanError)) throw error;
          io.out(error.message);
          status = 1;
        }
      }
      return status;
    }
    default:
      throw new OptionError(`unknown plan command ${subcommand}`);
  }
}

/** What `record` was asked to do. */
export interface RecordOptions {
  readonly plan: Plan;
  readonly adapter: string;
  readonly profile?: string;
  readonly output: string;
  /** The CSV or TSV file to write the run to as well. */
  readonly table?: { readonly path: string; readonly dialect: Dialect };
  readonly yesConfirm: boolean;
  readonly idBits: 11 | 29;
  readonly bitrate: number;
}

/**
 * Refuses, before anything is connected, a record that could not finish: an output file that exists, or a plan with a manual step and nobody to answer it.
 *
 * @throws OptionError naming the problem.
 */
export async function checkRecord(io: PlanIo, options: RecordOptions): Promise<void> {
  for (const path of [
    options.output,
    ...(options.table === undefined ? [] : [options.table.path]),
  ]) {
    if (await exists(io.directory, path)) {
      throw new OptionError(`${path} already exists; choose a new file`);
    }
  }
  if (asksToConfirm(options.plan) && io.interactive !== true && !options.yesConfirm) {
    throw new OptionError(
      `plan ${options.plan.name} has steps the person confirms, and the input is not a terminal; run it at a terminal, or pass --yes-confirm to confirm each step at once`,
    );
  }
}

function resultLine(read: string, result: ReadResult): string {
  switch (result.kind) {
    case "codes": {
      const all = result.units.flatMap((unit) =>
        unit.codes.map((code) => `${code} (${unit.unit})`),
      );
      return `${read}: ${all.length === 0 ? "none" : all.join(", ")}`;
    }
    case "freeze-frame": {
      const frames = result.units.map(
        (unit) =>
          `${unit.unit} ${unit.code ?? "no code"}${Object.entries(unit.values)
            .map(([label, value]) => `, ${label} ${value}`)
            .join("")}`,
      );
      return `${read}: ${frames.length === 0 ? "none stored" : frames.join("; ")}`;
    }
    case "misfire-counters": {
      const monitors = result.units.flatMap((unit) =>
        unit.monitors.map(
          (monitor) =>
            `${unit.unit} ${monitor.monitor.toString(16).toUpperCase()} last ${monitor.lastCycle === null ? "-" : String(monitor.lastCycle)} average ${monitor.averageLastTenCycles === null ? "-" : String(monitor.averageLastTenCycles)}`,
        ),
      );
      return `${read}: ${monitors.length === 0 ? "no misfire monitor reported" : monitors.join("; ")}`;
    }
    case "failed":
      return `${read}: not read: ${result.error}`;
  }
}

/** How often, in plan time, a progress line is printed when no status line can be redrawn. */
const PRINTED_PROGRESS_MS = 10_000;

/** Prints a running plan's events as banners, instructions, a status line and results. */
class Presenter {
  private startedAt = 0;
  private phaseLabel = "";
  private lastPrinted: number | undefined;
  private statusShown = false;

  constructor(
    private readonly io: PlanIo,
    private readonly runner: PlanRunner,
    private readonly options: RecordOptions,
  ) {}

  private line(text: string): void {
    if (this.statusShown) {
      this.io.err("\r\u001b[K");
      this.statusShown = false;
    }
    this.io.out(text);
  }

  private elapsed(at: number): string {
    return `+${((at - this.startedAt) / 1000).toFixed(1)} s`;
  }

  handle(event: PlanEvent): void {
    switch (event.type) {
      case "plan-started":
        this.startedAt = event.at;
        this.line(`plan ${event.plan.name}: ${event.plan.title}`);
        this.line("the person does the driving and pedal work; this program only reads");
        return;
      case "phase-started": {
        const total = this.options.plan.phases.length;
        const pass =
          event.iterations > 1
            ? ` (pass ${String(event.iteration)} of ${String(event.iterations)})`
            : "";
        this.phaseLabel = `${String(event.index + 1)}/${String(total)} ${event.phase.id}`;
        this.line("");
        this.line(
          `=== phase ${String(event.index + 1)} of ${String(total)}: ${event.phase.title}${pass} ===`,
        );
        this.line(`>>> ${event.phase.instruction}`);
        return;
      }
      case "waiting":
        this.lastPrinted = undefined;
        this.line(
          `${event.stage === "start" ? "starts" : "ends"} when ${event.condition} (at most ${String(event.timeoutMs / 1000)} s)`,
        );
        return;
      case "confirm-requested":
        if (this.options.yesConfirm) {
          this.line(`${event.prompt} confirmed by --yes-confirm`);
          this.runner.confirm();
          return;
        }
        void this.io.ask(`${event.prompt} Press Enter to confirm: `).then(() => {
          this.runner.confirm();
        });
        return;
      case "progress": {
        const remaining = Math.max(0, (event.timeoutMs - event.elapsedMs) / 1000).toFixed(0);
        const status = `[${this.phaseLabel}] ${event.progress} | ${(event.elapsedMs / 1000).toFixed(0)} s, times out in ${remaining} s`;
        if (this.io.interactive === true) {
          this.io.err(`\r\u001b[K${status}`);
          this.statusShown = true;
        } else if (
          this.lastPrinted === undefined ||
          event.at - this.lastPrinted >= PRINTED_PROGRESS_MS
        ) {
          this.lastPrinted = event.at;
          this.line(status);
        }
        return;
      }
      case "condition-met":
        this.line(`${event.stage === "start" ? "started" : "done"} at ${this.elapsed(event.at)}`);
        return;
      case "condition-timed-out":
        this.line(
          `timed out at ${this.elapsed(event.at)}; ${event.onTimeout === "skip" ? "going on to the next phase" : "the plan fails"}`,
        );
        return;
      case "code-appeared":
      case "code-cleared":
        this.line(
          `${event.code} ${event.type === "code-appeared" ? "appeared in" : "cleared from"} the ${event.list} codes at ${this.elapsed(event.at)}`,
        );
        return;
      case "read":
        this.line(resultLine(event.record.read, event.record.result));
        return;
      case "phase-finished":
        this.line(`phase ${event.record.phase} ${event.record.outcome}`);
        return;
      case "finished":
        this.line("");
        this.line(`plan ${event.outcome}${event.reason === undefined ? "" : `: ${event.reason}`}`);
        return;
      case "sample":
        return;
    }
  }
}

/**
 * Runs `record` on an initialised session: the plan's phases, each instruction printed with its condition and a status line, then the run written as a JSON export (and CSV or TSV when asked). An interrupt aborts the plan and the run is still written.
 *
 * @returns 0 when the plan completed, 1 when it failed, 130 when it was interrupted.
 */
export async function recordOnSession(
  io: PlanIo,
  elm: Elm,
  options: RecordOptions,
): Promise<number> {
  const storage = new MemoryStorage();
  const runner = new PlanRunner({
    plan: options.plan,
    link: { withSession: (work) => work({ elm }) },
    storage,
    adapter: options.adapter,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    idBits: options.idBits,
    bitrate: options.bitrate,
    onEvent: (event) => {
      presenter.handle(event);
    },
  });
  const presenter = new Presenter(io, runner, options);
  const abort = (): void => {
    runner.abort();
  };
  io.signal?.addEventListener("abort", abort);
  let result: PlanResult;
  try {
    if (io.signal?.aborted === true) runner.abort();
    result = await runner.run();
  } finally {
    io.signal?.removeEventListener("abort", abort);
  }
  const document = await exportRunJson(storage, result.runId);
  await writeNewFile(
    io.directory,
    options.output,
    new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
  );
  io.out(`wrote ${options.output}; share it with: obd-read share ${options.output}`);
  const table = options.table;
  if (table !== undefined) {
    await writeNewFile(
      io.directory,
      table.path,
      new TextEncoder().encode(await exportRunDelimitedText(storage, result.runId, table.dialect)),
    );
    io.out(`wrote ${table.path}`);
  }
  return result.outcome === "completed" ? 0 : result.outcome === "aborted" ? 130 : 1;
}
