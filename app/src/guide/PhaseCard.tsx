import { muted } from "../screens/screen.css";
import {
  countdown,
  instruction,
  meter,
  phaseCard,
  phaseStep,
  phaseTitle,
  reading,
  readingValue,
  readings,
  waitText,
} from "./guide.css";
import {
  countdownMs,
  formatDuration,
  waitCondition,
  type PlanView,
  type ViewReading,
} from "./plan-view";

/** A reading's value as the card shows it. */
function readingText(entry: ViewReading): string {
  if (entry.value === undefined) return "not read";
  const value =
    typeof entry.value === "number" ? String(Math.round(entry.value * 10) / 10) : entry.value;
  return entry.unit === "" ? value : `${value} ${entry.unit}`;
}

/** The step and pass a phase is at, in words: "Phase 2 of 4", with the pass of a repeated phase. */
export function phaseStepText(view: PlanView): string {
  const { current, plan } = view;
  if (current === undefined || plan === undefined) return "";
  const pass =
    current.iterations > 1
      ? `, pass ${String(current.iteration)} of ${String(current.iterations)}`
      : "";
  return `Phase ${String(current.index + 1)} of ${String(plan.phases.length)}${pass}`;
}

/**
 * The current phase in type meant to be read from arm's length on a phone propped in the car: the instruction, what the phase waits for with a countdown where it is a fixed time, how close it is to timing out, and the values it is sampling.
 */
export function PhaseCard({ view }: { readonly view: PlanView }) {
  const { current, wait, progress } = view;
  if (current === undefined) {
    return (
      <section className={phaseCard} aria-label="Current phase">
        <p className={phaseStep}>Getting ready…</p>
      </section>
    );
  }
  const timeoutMs = wait?.timeoutMs ?? 0;
  const elapsedMs = progress?.elapsedMs ?? 0;
  const fixed = countdownMs(current, wait);
  // A wait for the person alone repeats the confirm button's question; it is said once, on the button.
  const asksToConfirm =
    view.confirm !== undefined && waitCondition(current, wait)?.kind === "confirm";
  const timeoutAction =
    wait === undefined
      ? undefined
      : (wait.stage === "start" ? current.phase.start : current.phase.end)?.onTimeout;
  return (
    <section className={phaseCard} aria-label="Current phase">
      <p className={phaseStep}>{phaseStepText(view)}</p>
      <h2 className={phaseTitle}>{current.phase.title}</h2>
      <p className={instruction}>{current.phase.instruction}</p>
      {wait !== undefined && (
        <>
          <p className={waitText}>
            {asksToConfirm
              ? "Waiting for you to confirm."
              : `${wait.stage === "start" ? "Starts when" : "Ends when"} ${wait.condition}`}
          </p>
          {fixed !== undefined && (
            <p className={countdown} aria-label="Time left in this phase">
              {formatDuration(fixed - elapsedMs)}
            </p>
          )}
          {progress !== undefined && !asksToConfirm && <p className={waitText}>{progress.text}</p>}
          <progress
            className={meter}
            max={timeoutMs}
            value={Math.min(elapsedMs, timeoutMs)}
            aria-label="Time until the wait times out"
          />
          <p className={muted}>
            {`Times out in ${formatDuration(timeoutMs - elapsedMs)} (after ${formatDuration(timeoutMs)}), then ${timeoutAction === "fail" ? "the plan stops" : "goes on to the next phase"}.`}
          </p>
        </>
      )}
      {view.readings.length > 0 && (
        <dl className={readings} aria-label="Live values">
          {view.readings.map((entry) => (
            <div key={`${entry.name}-${entry.label}`} className={reading}>
              <dt className={muted}>{entry.label}</dt>
              <dd className={readingValue}>{readingText(entry)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
