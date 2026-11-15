import { PlanError, parsePlanText, type StartPlanInput } from "obd-read";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { failureMessage, type DiagnosticsClient } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { announcePhase } from "../guide/announce";
import { confirmButton, controls, visuallyHidden } from "../guide/guide.css";
import { PhaseCard, phaseStepText } from "../guide/PhaseCard";
import { PlanPreview, PlanSafety } from "../guide/PlanPreview";
import { PlanSummary } from "../guide/PlanSummary";
import {
  EMPTY_VIEW,
  formatMoment,
  planView,
  type PlanView,
  type ViewPlan,
} from "../guide/plan-view";
import { useSpeakPhases } from "../settings/speak-phases";
import { Button, Card, Switch } from "../ui";
import { error, list, muted, page, row, stack } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

/** A plan the person can start: a shipped one, or one read from a file. */
interface Choice {
  readonly key: string;
  readonly plan: ViewPlan;
  readonly input: StartPlanInput["plan"];
  readonly fromFile: boolean;
}

/** Why Start is disabled, or undefined when it is not. */
function startBlocker(
  connected: boolean,
  collecting: boolean,
  choice: Choice | undefined,
): string | undefined {
  if (!connected) return "Connect an adapter first: a plan reads the car as it goes.";
  if (collecting)
    return "Stop the collection run in the Session screen's Live section first: the plan needs the adapter.";
  if (choice === undefined) return "Choose a plan first.";
  return undefined;
}

/** Folds the plan's events into a view, replaying what has happened when the screen opens again, and announces each new phase once. */
function usePlanEvents(
  client: DiagnosticsClient,
  runId: string,
  announce: (view: PlanView) => void,
): PlanView {
  const [view, setView] = useState<PlanView>(EMPTY_VIEW);
  const announcer = useRef(announce);
  useEffect(() => {
    announcer.current = announce;
  }, [announce]);
  useEffect(() => {
    const live = { active: true };
    const stream = client.plans.events({ runId });
    void (async () => {
      let current = EMPTY_VIEW;
      try {
        for await (const event of await stream) {
          if (!live.active) break;
          current = planView(current, event);
          setView(current);
          if (event.type === "phase-started") announcer.current(current);
        }
      } catch {
        // The stream ends with the plan, or with the page; the status poll reports the end.
      }
    })();
    return () => {
      live.active = false;
      void stream.then((iterator) => iterator.return());
    };
  }, [client, runId]);
  return view;
}

/** A plan that is running or has run: the phase card, the controls and, once it ends, the summary. */
function RunningPlan({
  runId,
  onOpenRun,
}: {
  readonly runId: string;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { service, trackPlan, isNewPhase } = useDiagnostics();
  const { client } = service;
  const [speak, setSpeak] = useSpeakPhases();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const view = usePlanEvents(client, runId, (next) => {
    const current = next.current;
    if (current === undefined) return;
    if (!isNewPhase(`${runId}:${String(current.index)}:${String(current.iteration)}`)) return;
    announcePhase(`${current.phase.title}. ${current.phase.instruction}`, speak);
  });
  const ended = view.end !== undefined;

  const command = async (work: () => Promise<unknown>, failure: string): Promise<void> => {
    setProblem(undefined);
    try {
      await work();
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  };

  const announcement =
    view.end !== undefined
      ? `Plan ${view.end.outcome}.`
      : view.current === undefined
        ? ""
        : `${phaseStepText(view)}: ${view.current.phase.title}. ${view.current.phase.instruction}`;

  return (
    <div className={stack}>
      <p
        role="status"
        aria-live="assertive"
        aria-label="Phase announcements"
        className={visuallyHidden}
      >
        {announcement}
      </p>
      {view.plan !== undefined && <PlanSafety plan={view.plan} />}
      {!ended && <PhaseCard view={view} />}
      {!ended && view.confirm !== undefined && (
        <Button
          variant="primary"
          block
          className={confirmButton}
          onClick={() => void command(() => client.plans.confirm({ runId }), "Could not confirm.")}
        >
          {view.confirm} Confirm
        </Button>
      )}
      {!ended && (
        <div className={controls}>
          <Button
            onClick={() =>
              void command(() => client.plans.skip({ runId }), "Could not skip the phase.")
            }
          >
            Skip this phase
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void command(() => client.plans.abort({ runId }), "Could not abort the plan.")
            }
          >
            Abort the plan
          </Button>
        </div>
      )}
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {!ended && (
        <Switch label="Read each new phase aloud" checked={speak} onCheckedChange={setSpeak} />
      )}
      {view.notices.length > 0 && (
        <Card title="Notices">
          <ul className={list} aria-label="Notices">
            {view.notices.map((notice) => (
              <li key={`${String(notice.at)}-${notice.text}`}>
                {formatMoment(notice.at, view.startedAt)}: {notice.text}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {ended && (
        <PlanSummary
          view={view}
          client={client}
          onOpenRun={onOpenRun}
          onDone={() => {
            trackPlan(undefined);
          }}
        />
      )}
    </div>
  );
}

/** Choosing a plan: the shipped ones, a plan file, the chosen plan's phases and Start. */
function PlanPicker() {
  const { service, connection, collection, trackPlan } = useDiagnostics();
  const { client } = service;
  const [shipped, setShipped] = useState<readonly ViewPlan[] | undefined>(undefined);
  const [imported, setImported] = useState<Choice | undefined>(undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [problems, setProblems] = useState<{ file: string; lines: readonly string[] }>();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const live = { active: true };
    void client.plans.list().then((plans) => {
      if (live.active) setShipped(plans);
    });
    return () => {
      live.active = false;
    };
  }, [client]);

  const choices: Choice[] = [
    ...(shipped ?? []).map((plan) => ({
      key: `shipped:${plan.name}`,
      plan,
      input: { kind: "shipped" as const, name: plan.name },
      fromFile: false,
    })),
    ...(imported === undefined ? [] : [imported]),
  ];
  const choice = choices.find((entry) => entry.key === chosen);
  const blocker = startBlocker(connection !== undefined, collection.run !== undefined, choice);

  async function importFile(file: File): Promise<void> {
    setProblems(undefined);
    const text = await file.text();
    try {
      const plan = parsePlanText(text, file.name);
      const entry: Choice = {
        key: `file:${file.name}`,
        plan,
        input: { kind: "file", text, name: file.name },
        fromFile: true,
      };
      setImported(entry);
      setChosen(entry.key);
    } catch (caught) {
      if (!(caught instanceof PlanError)) throw caught;
      setProblems({ file: file.name, lines: caught.problems });
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file !== undefined) await importFile(file);
  }

  // Dropping a plan file anywhere on the picker reads it like the button does; the button stays for touch and keyboard use.
  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void importFile(file);
  }

  async function start(): Promise<void> {
    if (choice === undefined) return;
    setStarting(true);
    setProblem(undefined);
    try {
      trackPlan(await client.plans.start({ plan: choice.input }));
    } catch (caught) {
      setProblem(failureMessage(caught, "Could not start the plan."));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      className={stack}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <Card
        title="Choose a plan"
        description="A plan is a guided recording: it tells you what to do at the car, phase by phase, and records what the car reports meanwhile as an ordinary run."
      >
        {shipped === undefined && <p className={muted}>Loading plans…</p>}
        <ul className={list} aria-label="Plans">
          {choices.map((entry) => (
            <li key={entry.key}>
              <Button
                aria-pressed={entry.key === chosen}
                onClick={() => {
                  setChosen(entry.key);
                }}
              >
                {entry.fromFile ? `From file: ${entry.plan.title}` : entry.plan.title}
              </Button>
              <p className={muted}>{entry.plan.description}</p>
            </li>
          ))}
        </ul>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Plan file"
          onChange={(event) => void onFile(event)}
        />
        <Button block onClick={() => input.current?.click()}>
          Import a plan file
        </Button>
        <p className={muted}>Or drop a .obdplan.json file anywhere on this screen.</p>
        {problems !== undefined && (
          <div role="alert" className={error}>
            <p>{problems.file} is not a plan this app can run:</p>
            <ul className={list}>
              {problems.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      {choice !== undefined && (
        <Card title={choice.plan.title} description={`Source: ${choice.plan.source}`}>
          <PlanPreview plan={choice.plan} />
        </Card>
      )}
      <Button
        variant="primary"
        block
        disabled={blocker !== undefined || starting}
        onClick={() => void start()}
      >
        Start the plan
      </Button>
      {blocker !== undefined && <p className={muted}>{blocker}</p>}
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Guide: runs a recording plan on the connected adapter and tells the person what to do, phase by phase, in type readable from arm's length, with each new phase announced to assistive technology, by a short vibration and, when switched on, aloud. The screen is kept awake while the plan runs, and the plan carries on when another screen is opened.
 */
export function GuideScreen({ onOpenRun }: { readonly onOpenRun: (runId: string) => void }) {
  const { connection, guided, interruptedPlans } = useDiagnostics();
  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Guided recording</ScreenHeading>
      {interruptedPlans.length > 0 && (
        <Card
          title="Stopped by a reload"
          description="A plan does not carry on after the page is reloaded or closed, because each phase depends on what you were doing at the time. What it recorded is kept as a stopped run."
        >
          <ul className={list}>
            {interruptedPlans.map((run) => (
              <li key={run.id} className={row}>
                <span>
                  {run.notes} started{" "}
                  {new Date(run.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
                </span>
                <Button
                  onClick={() => {
                    onOpenRun(run.id);
                  }}
                >
                  Open in the Library
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {guided === undefined ? (
        <PlanPicker />
      ) : (
        <RunningPlan key={guided.runId} runId={guided.runId} onOpenRun={onOpenRun} />
      )}
    </div>
  );
}
