import {
  describePlanVersion,
  parsePlanText,
  PlanError,
  planEnvelope,
  planIdentity,
  type Plan,
  type PlanDocument,
} from "obd-read";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { unavailableBecause } from "../database/problem";
import { OriginBadge } from "../origin/OriginBadge";
import { error as errorText, list, muted } from "../screens/screen.css";
import { ShareDialog } from "../share/ShareDialog";
import { Button, Card, download } from "../ui";
import { actions, planList, planRow } from "./editor.css";
import {
  keepPlan,
  keptPlan,
  newPlanId,
  planFileName,
  planFileText,
  type KeptPlan,
} from "./my-plans";
import { blankPlan, PlanEditor } from "./PlanEditor";

/** What the editor is open on: a new plan, a copy, or a stored plan to change. */
type Editing =
  | { readonly id: string; readonly initial: PlanDocument; readonly previous: Plan | undefined }
  | undefined;

/** Props of {@link MyPlans}. */
export interface MyPlansProps {
  /** The key of the plan chosen to record, to mark it pressed. */
  readonly chosen: string | undefined;
  /** Chooses a kept plan to record: its key, the parsed plan and its file text for the service. */
  readonly onChoose: (key: string, plan: Plan, text: string) => void;
  /** A stored plan to choose as soon as it is listed, such as one opened from a link with Open in Guide. */
  readonly offered?: string | undefined;
}

/** The key a kept plan is chosen under. */
export function keptKey(id: string): string {
  return `kept:${id}`;
}

/**
 * My plans: the recording plans kept in this device's database, each marked with where it came from (made here, shared from a link or imported from a file) and its version, with create, edit, duplicate, delete, export, import and share. A plan that no longer validates is listed with its problems and cannot be chosen.
 */
export function MyPlans({ chosen, onChoose, offered }: MyPlansProps) {
  const { state, revision } = useDatabase();
  const storage = state.status === "ready" ? state.storage : undefined;
  const [plans, setPlans] = useState<readonly KeptPlan[] | undefined>(undefined);
  const [editing, setEditing] = useState<Editing>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [importProblems, setImportProblems] = useState<
    { readonly file: string; readonly lines: readonly string[] } | undefined
  >(undefined);
  const [reload, setReload] = useState(0);
  const offeredDone = useRef<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (storage === undefined) return;
    const live = { active: true };
    void storage.listPlans().then(
      (stored) => {
        if (live.active) setPlans(stored.map(keptPlan));
      },
      () => {
        if (live.active) setProblem("Could not read My plans.");
      },
    );
    return () => {
      live.active = false;
    };
  }, [storage, revision, reload]);

  useEffect(() => {
    if (offered === undefined || offeredDone.current === offered || plans === undefined) return;
    const entry = plans.find((item) => item.stored.id === offered);
    if (entry?.plan === undefined) return;
    offeredDone.current = offered;
    onChoose(keptKey(entry.stored.id), entry.plan, planFileText(entry.plan));
  }, [offered, plans, onChoose]);

  async function act(work: () => Promise<void>, failure: string): Promise<void> {
    setProblem(undefined);
    try {
      await work();
      setReload((value) => value + 1);
    } catch (caught) {
      setProblem(caught instanceof Error ? `${failure} ${caught.message}` : failure);
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined || storage === undefined) return;
    setImportProblems(undefined);
    let plan: Plan;
    try {
      plan = parsePlanText(await file.text(), file.name);
    } catch (caught) {
      if (!(caught instanceof PlanError)) throw caught;
      setImportProblems({ file: file.name, lines: caught.problems });
      return;
    }
    await act(async () => {
      await keepPlan(storage, plan, "imported", newPlanId());
    }, "Could not keep the imported plan.");
  }

  if (state.status !== "ready") {
    return (
      <Card title="My plans">
        <p className={muted}>
          {state.status === "opening"
            ? "The database is opening."
            : `My plans cannot be shown because ${unavailableBecause(state.problem, state.message)}.`}
        </p>
      </Card>
    );
  }
  const { storage: ready } = state;

  if (editing !== undefined) {
    return (
      <Card
        title={editing.previous === undefined ? "New plan" : `Edit ${editing.previous.title}`}
        description="Every change is checked as it is made, with the same rules a plan must pass before it runs."
      >
        <PlanEditor
          initial={editing.initial}
          previous={editing.previous}
          onCancel={() => {
            setEditing(undefined);
          }}
          onSave={async (plan) => {
            await keepPlan(ready, plan, "local", editing.id);
            setEditing(undefined);
            setReload((value) => value + 1);
          }}
        />
      </Card>
    );
  }

  return (
    <Card
      title="My plans"
      description="Plans you made, imported or saved from a link. Send one to someone as a link; the results they record come back as a link too."
    >
      {plans === undefined && <p className={muted}>Loading My plans…</p>}
      {plans?.length === 0 && <p className={muted}>No plans kept yet.</p>}
      <ul className={planList} aria-label="My plans">
        {(plans ?? []).map((entry) => {
          const { stored, plan } = entry;
          const key = keptKey(stored.id);
          return (
            <li key={stored.id} className={planRow}>
              <span>
                <strong>{stored.title}</strong> <OriginBadge origin={stored.origin} />
              </span>
              {plan === undefined ? (
                <ul
                  className={[list, errorText].join(" ")}
                  aria-label={`Problems in ${stored.title}`}
                >
                  {entry.problems.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <span className={muted}>
                  {plan.name}, {describePlanVersion(planIdentity(plan))}, {plan.phases.length}{" "}
                  {plan.phases.length === 1 ? "phase" : "phases"}
                </span>
              )}
              <div className={actions}>
                {plan !== undefined && (
                  <Button
                    variant={key === chosen ? "primary" : "secondary"}
                    aria-pressed={key === chosen}
                    onClick={() => {
                      onChoose(key, plan, planFileText(plan));
                    }}
                  >
                    Record {stored.title}
                  </Button>
                )}
                {plan !== undefined && (
                  <Button
                    onClick={() => {
                      setEditing({ id: stored.id, initial: plan, previous: plan });
                    }}
                  >
                    Edit
                  </Button>
                )}
                {plan !== undefined && (
                  <Button
                    onClick={() =>
                      void act(async () => {
                        await keepPlan(
                          ready,
                          {
                            ...plan,
                            name: `${plan.name}-copy`,
                            title: `${plan.title} (copy)`,
                            revision: 1,
                          },
                          "local",
                          newPlanId(),
                        );
                      }, "Could not duplicate the plan.")
                    }
                  >
                    Duplicate
                  </Button>
                )}
                {plan !== undefined && (
                  <Button
                    onClick={() => {
                      download(planFileName(plan), "application/json", planFileText(plan));
                    }}
                  >
                    Export file
                  </Button>
                )}
                {plan !== undefined && (
                  <ShareDialog
                    label="Share link"
                    title={`Share ${plan.title}`}
                    load={() => Promise.resolve(planEnvelope(plan, Date.now()))}
                  />
                )}
                <Button
                  variant="ghost"
                  onClick={() =>
                    void act(() => ready.deletePlan(stored.id), "Could not delete the plan.")
                  }
                >
                  Delete {stored.title}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Import into My plans"
        onChange={(event) => void importFile(event)}
      />
      <div className={actions}>
        <Button
          variant="primary"
          onClick={() => {
            setEditing({ id: newPlanId(), initial: blankPlan(), previous: undefined });
          }}
        >
          New plan
        </Button>
        <Button onClick={() => input.current?.click()}>Import a file into My plans</Button>
      </div>
      {importProblems !== undefined && (
        <div role="alert" className={errorText}>
          <p>{importProblems.file} is not a plan this app can keep:</p>
          <ul className={list}>
            {importProblems.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {problem !== undefined && (
        <p role="alert" className={errorText}>
          {problem}
        </p>
      )}
    </Card>
  );
}
