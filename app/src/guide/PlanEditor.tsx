import {
  PLAN_READS,
  PLAN_VALUE_NAMES,
  PlanError,
  describePlanVersion,
  parsePlan,
  planDigest,
  planIdentity,
  type Plan,
  type PlanDocument,
  type PlanDocumentPhase,
  type PlanRepeat,
} from "obd-read";
import { useId, useState } from "react";
import { error as errorText, muted, stack } from "../screens/screen.css";
import { groupOf } from "../screens/live/groups";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "../ui";
import {
  NumberField,
  SelectField,
  TextInput,
  WaitEditor,
  type WaitEditorProps,
} from "./ConditionEditor";
import {
  actions,
  bareFieldset,
  check,
  checkBox,
  checklist,
  control,
  fieldLabel,
  fieldStack,
  fields,
  group,
  foldable,
  legend,
  problems as problemList,
  textarea,
} from "./editor.css";
import { PlanPreview } from "./PlanPreview";

/** What validating a draft gave: the plan, or every problem `parsePlan` found, each with its path. */
export type Checked =
  | { readonly plan: Plan; readonly problems: readonly [] }
  | { readonly plan: undefined; readonly problems: readonly string[] };

/** Validates a draft with the same `parsePlan` every plan goes through before it can run. */
export function checkDraft(draft: unknown): Checked {
  try {
    return { plan: parsePlan(draft, "plan"), problems: [] };
  } catch (caught) {
    if (!(caught instanceof PlanError)) throw caught;
    return { plan: undefined, problems: caught.problems };
  }
}

/** A plan document to start a new plan from: one phase that ends after ten seconds. */
export function blankPlan(): PlanDocument {
  return {
    format: "obd-read-plan",
    version: 1,
    name: "my-plan",
    title: "My plan",
    description: "What this plan records and why.",
    safety: "Parked, handbrake on, in neutral or P, in a ventilated space.",
    revision: 1,
    source: "Written in the plan editor.",
    needs: { values: ["engine-speed", "coolant-temperature"] },
    phases: [newPhase(1)],
  };
}

function newPhase(position: number): PlanDocumentPhase {
  return {
    id: `phase-${String(position)}`,
    title: `Phase ${String(position)}`,
    instruction: "What the person does in this phase.",
    sample: { every: 1 },
    reads: { start: [], end: [] },
    end: { when: { kind: "elapsed", seconds: 10 }, timeout: 30, onTimeout: "skip" },
  };
}

/** The problems whose path starts with `prefix`, such as `phases.2.`, without it. */
function problemsAt(problems: readonly string[], prefix: string): string[] {
  return problems.filter((problem) => problem.startsWith(prefix));
}

function Problems({ items, label }: { readonly items: readonly string[]; readonly label: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={problemList} aria-label={label}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className={check}>
      <input
        className={checkBox}
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
      {label}
    </label>
  );
}

/** A checklist of value names, grouped under the headings the Live picker uses. */
function ValueChecklist({
  label,
  names,
  selected,
  onChange,
}: {
  readonly label: string;
  readonly names: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (selected: string[]) => void;
}) {
  const headings = [...new Set(names.map(groupOf))];
  // Folded by default: the full list is long, and on a phone it would push the phases far down.
  return (
    <details className={group}>
      <summary className={check}>
        {label}: {selected.length === 0 ? "none chosen" : selected.join(", ")}
      </summary>
      <fieldset className={bareFieldset} aria-label={label}>
        {headings.map((heading) => (
          <div key={heading} className={fieldStack}>
            <span className={fieldLabel}>{heading}</span>
            <ul className={checklist}>
              {names
                .filter((name) => groupOf(name) === heading)
                .map((name) => (
                  <li key={name}>
                    <Check
                      label={name}
                      checked={selected.includes(name)}
                      onChange={(on) => {
                        onChange(
                          on
                            ? names.filter((item) => item === name || selected.includes(item))
                            : selected.filter((item) => item !== name),
                        );
                      }}
                    />
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </fieldset>
    </details>
  );
}

const REPEAT_CHOICES = [
  ["once", "Once"],
  ["times", "A fixed number of times"],
  ["until", "Until a condition holds"],
] as const;

function PhaseEditor({
  phase,
  index,
  count,
  planValues,
  problems,
  onChange,
  onMove,
  onRemove,
}: {
  readonly phase: PlanDocumentPhase;
  readonly index: number;
  readonly count: number;
  readonly planValues: readonly string[] | "all";
  readonly problems: readonly string[];
  readonly onChange: (phase: PlanDocumentPhase) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const name = `Phase ${String(index + 1)}`;
  const available = planValues === "all" ? PLAN_VALUE_NAMES : planValues;
  const sampled = phase.sample?.values;
  const tested = sampled ?? available;
  const every = phase.sample?.every ?? 1;
  const reads = { start: phase.reads?.start ?? [], end: phase.reads?.end ?? [] };
  const waitProps = (label: string): Omit<WaitEditorProps, "wait" | "onChange"> => ({
    label,
    values: tested,
  });
  const repeat = phase.repeat;
  const repeatChoice = repeat === undefined ? "once" : "times" in repeat ? "times" : "until";
  // An optional field set to undefined is left out of the plan, as JSON leaves it out.
  const setRepeat = (next: PlanRepeat | undefined): void => {
    onChange({ ...phase, repeat: next });
  };
  return (
    <fieldset className={group} aria-label={`${name}: ${phase.title}`}>
      <legend className={legend}>
        {name}: {phase.title}
      </legend>
      <details open className={foldable}>
        <summary>{`${name} fields`}</summary>
        <Problems items={problems} label={`Problems in ${name}`} />
        <div className={fields}>
          <TextInput
            label={`${name}: id`}
            value={phase.id}
            onChange={(id) => {
              onChange({ ...phase, id: id ?? "" });
            }}
          />
          <TextInput
            label={`${name}: title`}
            value={phase.title}
            onChange={(title) => {
              onChange({ ...phase, title: title ?? "" });
            }}
          />
        </div>
        <TextInput
          label={`${name}: instruction`}
          value={phase.instruction}
          onChange={(instruction) => {
            onChange({ ...phase, instruction: instruction ?? "" });
          }}
        />
        <Check
          label={`${name}: sample every value the plan reads`}
          checked={sampled === undefined}
          onChange={(all) => {
            onChange({
              ...phase,
              sample: all ? { every } : { every, values: available.slice(0, 1) },
            });
          }}
        />
        {sampled !== undefined && (
          <ValueChecklist
            label={`${name}: values to sample`}
            names={available}
            selected={sampled}
            onChange={(values) => {
              onChange({ ...phase, sample: { every, values } });
            }}
          />
        )}
        <div className={fields}>
          <Check
            label={`${name}: sample as fast as the car answers`}
            checked={every === "fastest"}
            onChange={(fastest) => {
              onChange({
                ...phase,
                sample: { ...phase.sample, every: fastest ? "fastest" : 1 },
              });
            }}
          />
          {every !== "fastest" && (
            <NumberField
              label={`${name}: seconds between samples`}
              value={every}
              onChange={(seconds) => {
                onChange({ ...phase, sample: { ...phase.sample, every: seconds ?? Number.NaN } });
              }}
            />
          )}
        </div>
        {(["start", "end"] as const).map((when) => (
          <fieldset key={when} className={group}>
            <legend className={legend}>
              {name}: reads at the {when}
            </legend>
            <ul className={checklist}>
              {PLAN_READS.map((read) => (
                <li key={read}>
                  <Check
                    label={`${read} at the ${when}`}
                    checked={reads[when].includes(read)}
                    onChange={(on) => {
                      const chosen = on
                        ? PLAN_READS.filter((item) => item === read || reads[when].includes(item))
                        : reads[when].filter((item) => item !== read);
                      onChange({ ...phase, reads: { ...reads, [when]: chosen } });
                    }}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
        <Check
          label={`${name}: watch the fault code lists throughout`}
          checked={phase.watchCodes === true}
          onChange={(watchCodes) => {
            onChange({ ...phase, watchCodes });
          }}
        />
        <Check
          label={`${name}: wait for a condition before it starts`}
          checked={phase.start !== undefined}
          onChange={(on) => {
            onChange({
              ...phase,
              start: on
                ? { when: { kind: "confirm", prompt: "Ready?" }, timeout: 120, onTimeout: "skip" }
                : undefined,
            });
          }}
        />
        {phase.start !== undefined && (
          <WaitEditor
            {...waitProps(`${name} start condition`)}
            wait={phase.start}
            onChange={(start) => {
              onChange({ ...phase, start });
            }}
          />
        )}
        <WaitEditor
          {...waitProps(`${name} end condition`)}
          wait={phase.end}
          onChange={(end) => {
            onChange({ ...phase, end });
          }}
        />
        <div className={fields}>
          <SelectField
            label={`${name}: repeat`}
            value={repeatChoice}
            options={REPEAT_CHOICES}
            onChange={(choice) => {
              if (choice === "once") setRepeat(undefined);
              if (choice === "times") setRepeat({ times: 2 });
              if (choice === "until") {
                setRepeat({ until: { kind: "samples", count: 10 }, max: 3 });
              }
            }}
          />
          {repeat !== undefined && "times" in repeat && (
            <NumberField
              label={`${name}: times`}
              value={repeat.times}
              onChange={(times) => {
                setRepeat({ times: times ?? Number.NaN });
              }}
            />
          )}
          {repeat !== undefined && "until" in repeat && (
            <NumberField
              label={`${name}: at most this many times`}
              value={repeat.max}
              onChange={(max) => {
                setRepeat({ ...repeat, max: max ?? Number.NaN });
              }}
            />
          )}
        </div>
      </details>
      <div className={actions}>
        <Button
          disabled={index === 0}
          onClick={() => {
            onMove(-1);
          }}
        >
          Move {name} up
        </Button>
        <Button
          disabled={index === count - 1}
          onClick={() => {
            onMove(1);
          }}
        >
          Move {name} down
        </Button>
        <Button variant="ghost" disabled={count === 1} onClick={onRemove}>
          Remove {name}
        </Button>
      </div>
    </fieldset>
  );
}

/** Props of {@link PlanEditor}. */
export interface PlanEditorProps {
  /** The document to start from: a blank plan, a copy or a stored plan. */
  readonly initial: PlanDocument;
  /** The stored version being edited; a saved change raises its revision by one. Undefined for a new plan. */
  readonly previous?: Plan | undefined;
  readonly onSave: (plan: Plan) => Promise<void>;
  readonly onCancel: () => void;
}

/** The plan to save: the draft with its revision one past the previous version's when anything but the revision changed, so every saved change is a new version. */
export function revised(plan: Plan, previous: Plan | undefined): Plan {
  if (previous === undefined) return plan;
  const before = previous.revision ?? 1;
  const unchanged = planDigest({ ...plan, revision: before }) === planDigest(previous);
  return { ...plan, revision: unchanged ? before : Math.max(before + 1, plan.revision ?? 1) };
}

/**
 * The plan editor: a form for every field of a plan (its phases added, reordered and removed, each with its values, sampling, reads, start and end conditions and repeat), validated on every change by the same `parsePlan` that runs before any plan starts, with each problem shown beside its phase; a preview of exactly what the person recording sees; and the raw JSON for advanced edits, which must validate before it is used or saved.
 */
export function PlanEditor({ initial, previous, onSave, onCancel }: PlanEditorProps) {
  const [draft, setDraft] = useState<PlanDocument>(initial);
  // Stable keys for the phases, so reordering keeps each phase's fields and focus with it.
  const [keys, setKeys] = useState<string[]>(() => draft.phases.map(() => crypto.randomUUID()));
  const [tab, setTab] = useState("form");
  const [json, setJson] = useState<string | undefined>(undefined);
  const [jsonProblems, setJsonProblems] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const jsonId = useId();
  const checked = checkDraft(draft);
  const general = checked.problems.filter((problem) => !problem.startsWith("phases."));
  const planValues = draft.needs.values;
  const toSave = checked.plan === undefined ? undefined : revised(checked.plan, previous);

  const update = (next: PlanDocument): void => {
    setDraft(next);
  };
  const setPhases = (phases: PlanDocumentPhase[], nextKeys: string[]): void => {
    setKeys(nextKeys);
    update({ ...draft, phases });
  };

  /** Reads the JSON tab into the draft; false, with the problems shown, when it is not a valid plan. */
  function applyJson(): Plan | undefined {
    if (json === undefined) return checked.plan;
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch (caught) {
      setJsonProblems([caught instanceof Error ? caught.message : "not JSON"]);
      return undefined;
    }
    const result = checkDraft(data);
    setJsonProblems(result.problems);
    if (result.plan === undefined) return undefined;
    setDraft(result.plan);
    setKeys(result.plan.phases.map(() => crypto.randomUUID()));
    setJson(undefined);
    return result.plan;
  }

  async function save(): Promise<void> {
    const plan = tab === "json" ? applyJson() : checked.plan;
    if (plan === undefined) return;
    setSaving(true);
    setFailure(undefined);
    try {
      await onSave(revised(plan, previous));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The plan could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={stack}>
      <p className={muted} role="status" aria-label="Plan version">
        {toSave === undefined
          ? `Not valid yet: ${String(checked.problems.length)} problem${checked.problems.length === 1 ? "" : "s"} to fix before it can be saved.`
          : `Valid. Saves as ${describePlanVersion(planIdentity(toSave))}.`}
      </p>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (tab === "json" && next !== "json" && applyJson() === undefined) return;
          setTab(next);
        }}
      >
        <TabsList aria-label="Plan editor views">
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="form">
          <div className={stack}>
            <Problems items={general} label="Problems in the plan" />
            <div className={fields}>
              <TextInput
                label="Name (lower case letters, digits and hyphens)"
                value={draft.name}
                onChange={(name) => {
                  update({ ...draft, name: name ?? "" });
                }}
              />
              <TextInput
                label="Title"
                value={draft.title}
                onChange={(title) => {
                  update({ ...draft, title: title ?? "" });
                }}
              />
            </div>
            <TextInput
              label="Description"
              value={draft.description}
              onChange={(description) => {
                update({ ...draft, description: description ?? "" });
              }}
            />
            <TextInput
              label="Safety text, kept in view while it runs"
              value={draft.safety}
              optional
              onChange={(safety) => {
                update({ ...draft, safety });
              }}
            />
            <TextInput
              label="Source"
              value={draft.source}
              onChange={(source) => {
                update({ ...draft, source: source ?? "" });
              }}
            />
            <Check
              label="Read every value the car reports"
              checked={planValues === "all"}
              onChange={(all) => {
                update({
                  ...draft,
                  needs: { ...draft.needs, values: all ? "all" : ["engine-speed"] },
                });
              }}
            />
            {planValues !== "all" && (
              <ValueChecklist
                label="Values the plan reads"
                names={PLAN_VALUE_NAMES}
                selected={planValues}
                onChange={(values) => {
                  update({ ...draft, needs: { ...draft.needs, values } });
                }}
              />
            )}
            {draft.phases.map((phase, index) => (
              <PhaseEditor
                key={keys[index] ?? String(index)}
                phase={phase}
                index={index}
                count={draft.phases.length}
                planValues={planValues}
                problems={problemsAt(checked.problems, `phases.${String(index)}.`)}
                onChange={(next) => {
                  setPhases(
                    draft.phases.map((item, at) => (at === index ? next : item)),
                    keys,
                  );
                }}
                onMove={(by) => {
                  const target = index + by;
                  const phases = [...draft.phases];
                  const order = [...keys];
                  const [moved] = phases.splice(index, 1);
                  const [movedKey] = order.splice(index, 1);
                  if (moved === undefined || movedKey === undefined) return;
                  phases.splice(target, 0, moved);
                  order.splice(target, 0, movedKey);
                  setPhases(phases, order);
                }}
                onRemove={() => {
                  setPhases(
                    draft.phases.filter((_, at) => at !== index),
                    keys.filter((_, at) => at !== index),
                  );
                }}
              />
            ))}
            <div className={actions}>
              <Button
                onClick={() => {
                  setPhases(
                    [...draft.phases, newPhase(draft.phases.length + 1)],
                    [...keys, crypto.randomUUID()],
                  );
                }}
              >
                Add a phase
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="preview">
          {checked.plan === undefined ? (
            <p className={muted}>The preview shows once the plan is valid.</p>
          ) : (
            <div className={stack} aria-label="Preview of what the person recording sees">
              <h3>{checked.plan.title}</h3>
              <PlanPreview plan={checked.plan} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="json">
          <div className={fieldStack}>
            <label htmlFor={jsonId} className={fieldLabel}>
              Plan JSON
            </label>
            <textarea
              id={jsonId}
              className={[control, textarea].join(" ")}
              spellCheck={false}
              value={json ?? JSON.stringify(draft, null, 2)}
              onChange={(event) => {
                setJson(event.currentTarget.value);
              }}
            />
            <Problems items={jsonProblems} label="Problems in the JSON" />
            <div className={actions}>
              <Button
                disabled={json === undefined}
                onClick={() => {
                  applyJson();
                }}
              >
                Check and use this JSON
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
      {failure !== undefined && (
        <p role="alert" className={errorText}>
          {failure}
        </p>
      )}
      <div className={actions}>
        <Button
          variant="primary"
          disabled={saving || (tab !== "json" && checked.plan === undefined)}
          onClick={() => void save()}
        >
          Save the plan
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
