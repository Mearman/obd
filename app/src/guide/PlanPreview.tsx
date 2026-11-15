import { describeCondition, describeWait } from "obd-read";
import { muted } from "../screens/screen.css";
import { phaseList, safety } from "./guide.css";
import type { ViewPhase, ViewPlan } from "./plan-view";

/** What a phase samples, in words. */
export function sampledText(plan: ViewPlan, phase: ViewPhase): string {
  const values = phase.sample.values ?? plan.needs.values;
  const which = values === "all" ? "every value the car reports" : values.join(", ");
  const every =
    phase.sample.every === "fastest"
      ? "as fast as the car answers"
      : `every ${String(phase.sample.every)} s`;
  return `${which}, ${every}`;
}

/** How often a phase runs, in words, or undefined for once. */
function repeatText(phase: ViewPhase): string | undefined {
  const repeat = phase.repeat;
  if (repeat === undefined) return undefined;
  return "times" in repeat
    ? `Runs ${String(repeat.times)} times.`
    : `Runs at most ${String(repeat.max)} times, until ${describeCondition(repeat.until)}.`;
}

/** The plan's own text about who does what at the car (its safety text, else its description), which the screen keeps in view because the person, not this app, works the car. */
export function PlanSafety({ plan }: { readonly plan: ViewPlan }) {
  return (
    <p className={safety}>
      <strong>At the car: </strong>
      {plan.safety ?? plan.description} This app only reads; the person does the driving and the
      pedal work.
    </p>
  );
}

/** Every phase of a plan in order: title, instruction, what is sampled and when it starts and ends. */
export function PlanPreview({ plan }: { readonly plan: ViewPlan }) {
  return (
    <>
      <PlanSafety plan={plan} />
      {plan.safety !== undefined && <p>{plan.description}</p>}
      <ol className={phaseList} aria-label={`Phases of ${plan.title}`}>
        {plan.phases.map((phase) => {
          const repeat = repeatText(phase);
          const reads = [
            ...phase.reads.start.map((read) => `${read} at the start`),
            ...phase.reads.end.map((read) => `${read} at the end`),
          ];
          return (
            <li key={phase.id}>
              <strong>{phase.title}</strong>
              <p>{phase.instruction}</p>
              <p className={muted}>Samples {sampledText(plan, phase)}.</p>
              {phase.start !== undefined && (
                <p className={muted}>Starts when {describeWait(phase.start)}.</p>
              )}
              <p className={muted}>Ends when {describeWait(phase.end)}.</p>
              {repeat !== undefined && <p className={muted}>{repeat}</p>}
              {reads.length > 0 && <p className={muted}>Reads {reads.join(", ")}.</p>}
            </li>
          );
        })}
      </ol>
    </>
  );
}
