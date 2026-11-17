import {
  COMPARISONS,
  FAULT_LISTS,
  ON_TIMEOUT,
  type PlanCondition,
  type PlanDocumentWait,
} from "obd-read";
import { useId, type ReactNode } from "react";
import { Button } from "../ui";
import { actions, control, fieldLabel, fieldStack, fields, group, legend } from "./editor.css";

/** Each way of building a condition the editor offers: every condition kind in the plan schema, with the value comparisons split out. */
export const CONDITION_CHOICES = [
  ["elapsed", "After a number of seconds"],
  ["samples", "After a number of samples"],
  ["compare", "A value above or below a number"],
  ["between", "A value in a range"],
  ["stable", "A value holding steady"],
  ["code-appears", "A fault code appears"],
  ["code-clears", "A fault code clears"],
  ["confirm", "The person confirms"],
  ["any", "Any of several conditions"],
  ["all", "All of several conditions"],
] as const;

/** One of {@link CONDITION_CHOICES}. */
export type ConditionChoice = (typeof CONDITION_CHOICES)[number][0];

function isChoice(value: string): value is ConditionChoice {
  return CONDITION_CHOICES.some(([choice]) => choice === value);
}

/** Which choice builds `condition`. */
export function choiceOf(condition: PlanCondition): ConditionChoice {
  if (condition.kind !== "value") return condition.kind;
  return condition.op === "between" ? "between" : condition.op === "stable" ? "stable" : "compare";
}

/** A condition of the chosen kind with workable starting values; `value` is the value name a value condition tests. */
export function newCondition(choice: ConditionChoice, value: string): PlanCondition {
  switch (choice) {
    case "elapsed":
      return { kind: "elapsed", seconds: 10 };
    case "samples":
      return { kind: "samples", count: 10 };
    case "compare":
      return { kind: "value", value, op: ">", than: 0 };
    case "between":
      return { kind: "value", value, op: "between", min: 0, max: 100 };
    case "stable":
      return { kind: "value", value, op: "stable", within: 5, for: 10 };
    case "code-appears":
      return { kind: "code-appears" };
    case "code-clears":
      return { kind: "code-clears" };
    case "confirm":
      return { kind: "confirm", prompt: "Ready?" };
    case "any":
    case "all":
      return { kind: choice, of: [{ kind: "elapsed", seconds: 10 }] };
  }
}

/** A labelled native select with a 44 px target. */
export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={fieldStack}>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <select
        id={id}
        className={control}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A labelled number input; an empty field gives `undefined` when `optional`, else NaN, which validation reports. */
export function NumberField({
  label,
  value,
  onChange,
  optional = false,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly optional?: boolean;
}) {
  const id = useId();
  return (
    <div className={fieldStack}>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <input
        id={id}
        className={control}
        type="number"
        inputMode="decimal"
        step="any"
        value={value === undefined || Number.isNaN(value) ? "" : String(value)}
        onChange={(event) => {
          const text = event.currentTarget.value;
          onChange(text === "" ? (optional ? undefined : Number.NaN) : Number(text));
        }}
      />
    </div>
  );
}

/** A labelled single-line text input; an empty field gives `undefined` when `optional`. */
export function TextInput({
  label,
  value,
  onChange,
  optional = false,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
  readonly optional?: boolean;
}) {
  const id = useId();
  return (
    <div className={fieldStack}>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <input
        id={id}
        className={control}
        value={value ?? ""}
        autoComplete="off"
        onChange={(event) => {
          const text = event.currentTarget.value;
          onChange(text === "" && optional ? undefined : text);
        }}
      />
    </div>
  );
}

/** Props of {@link ConditionEditor}. */
export interface ConditionEditorProps {
  /** Names the condition in every label, such as "End condition" or "End condition, part 2". */
  readonly label: string;
  readonly condition: PlanCondition;
  readonly onChange: (condition: PlanCondition) => void;
  /** The value names a value condition may test: the ones the phase samples. */
  readonly values: readonly string[];
}

/**
 * Builds one condition of any kind the plan schema has, nesting for "any of" and "all of". Every field is a native control, so the whole builder works by keyboard; validation is left to `parsePlan`, which the editor runs on every change.
 */
export function ConditionEditor({ label, condition, onChange, values }: ConditionEditorProps) {
  const choice = choiceOf(condition);
  const firstValue = values[0] ?? "engine-speed";
  let body: ReactNode = null;
  switch (condition.kind) {
    case "elapsed":
      body = (
        <NumberField
          label={`${label}: seconds`}
          value={condition.seconds}
          onChange={(seconds) => {
            onChange({ ...condition, seconds: seconds ?? Number.NaN });
          }}
        />
      );
      break;
    case "samples":
      body = (
        <NumberField
          label={`${label}: samples`}
          value={condition.count}
          onChange={(count) => {
            onChange({ ...condition, count: count ?? Number.NaN });
          }}
        />
      );
      break;
    case "value": {
      const valueField = (
        <SelectField
          label={`${label}: value`}
          value={condition.value}
          options={(values.includes(condition.value) ? values : [condition.value, ...values]).map(
            (name) => [name, name],
          )}
          onChange={(value) => {
            onChange({ ...condition, value });
          }}
        />
      );
      if (condition.op === "stable") {
        body = (
          <>
            {valueField}
            <NumberField
              label={`${label}: within`}
              value={condition.within}
              onChange={(within) => {
                onChange({ ...condition, within: within ?? Number.NaN });
              }}
            />
            <NumberField
              label={`${label}: for seconds`}
              value={condition.for}
              onChange={(seconds) => {
                onChange({ ...condition, for: seconds ?? Number.NaN });
              }}
            />
          </>
        );
      } else {
        const held = (
          <NumberField
            label={`${label}: held for seconds (optional)`}
            value={condition.for}
            optional
            onChange={(seconds) => {
              onChange({ ...condition, for: seconds });
            }}
          />
        );
        body =
          condition.op === "between" ? (
            <>
              {valueField}
              <NumberField
                label={`${label}: from`}
                value={condition.min}
                onChange={(min) => {
                  onChange({ ...condition, min: min ?? Number.NaN });
                }}
              />
              <NumberField
                label={`${label}: to`}
                value={condition.max}
                onChange={(max) => {
                  onChange({ ...condition, max: max ?? Number.NaN });
                }}
              />
              {held}
            </>
          ) : (
            <>
              {valueField}
              <SelectField
                label={`${label}: comparison`}
                value={condition.op}
                options={COMPARISONS.map((op) => [op, op])}
                onChange={(op) => {
                  const chosen = COMPARISONS.find((known) => known === op);
                  if (chosen !== undefined) onChange({ ...condition, op: chosen });
                }}
              />
              <NumberField
                label={`${label}: than`}
                value={condition.than}
                onChange={(than) => {
                  onChange({ ...condition, than: than ?? Number.NaN });
                }}
              />
              {held}
            </>
          );
      }
      break;
    }
    case "code-appears":
    case "code-clears":
      body = (
        <>
          <SelectField
            label={`${label}: list`}
            value={condition.list ?? ""}
            options={[["", "Any list"], ...FAULT_LISTS.map((list) => [list, list] as const)]}
            onChange={(list) => {
              const chosen = FAULT_LISTS.find((known) => known === list);
              onChange({ kind: condition.kind, list: chosen, code: condition.code });
            }}
          />
          <TextInput
            label={`${label}: code (optional, such as P0300)`}
            value={condition.code}
            optional
            onChange={(code) => {
              onChange({ ...condition, code: code?.toUpperCase() });
            }}
          />
        </>
      );
      break;
    case "confirm":
      body = (
        <TextInput
          label={`${label}: question for the person`}
          value={condition.prompt}
          optional
          onChange={(prompt) => {
            onChange({ ...condition, prompt });
          }}
        />
      );
      break;
    case "any":
    case "all": {
      const parts = condition.of;
      body = (
        <div className={fieldStack}>
          {parts.map((part, index) => (
            <div key={index} className={group}>
              <ConditionEditor
                label={`${label}, part ${String(index + 1)}`}
                condition={part}
                values={values}
                onChange={(next) => {
                  onChange({
                    ...condition,
                    of: parts.map((item, at) => (at === index ? next : item)),
                  });
                }}
              />
              {parts.length > 1 && (
                <div className={actions}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onChange({ ...condition, of: parts.filter((_, at) => at !== index) });
                    }}
                  >
                    Remove {label}, part {String(index + 1)}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div className={actions}>
            <Button
              onClick={() => {
                onChange({ ...condition, of: [...parts, { kind: "elapsed", seconds: 10 }] });
              }}
            >
              Add a part to {label}
            </Button>
          </div>
        </div>
      );
      break;
    }
  }
  return (
    <div className={fieldStack}>
      <SelectField
        label={`${label}: kind`}
        value={choice}
        options={CONDITION_CHOICES}
        onChange={(next) => {
          if (isChoice(next) && next !== choice) onChange(newCondition(next, firstValue));
        }}
      />
      <div className={fields}>{body}</div>
    </div>
  );
}

/** Props of {@link WaitEditor}. */
export interface WaitEditorProps {
  readonly label: string;
  readonly wait: PlanDocumentWait;
  readonly onChange: (wait: PlanDocumentWait) => void;
  readonly values: readonly string[];
}

/** A wait: its condition, the timeout every wait must have, and whether running out skips the phase or fails the plan. */
export function WaitEditor({ label, wait, onChange, values }: WaitEditorProps) {
  return (
    <fieldset className={group}>
      <legend className={legend}>{label}</legend>
      <ConditionEditor
        label={label}
        condition={wait.when}
        values={values}
        onChange={(when) => {
          onChange({ ...wait, when });
        }}
      />
      <div className={fields}>
        <NumberField
          label={`${label}: timeout in seconds`}
          value={wait.timeout}
          onChange={(timeout) => {
            onChange({ ...wait, timeout: timeout ?? Number.NaN });
          }}
        />
        <SelectField
          label={`${label}: when the timeout runs out`}
          value={wait.onTimeout ?? "fail"}
          options={ON_TIMEOUT.map((choice) => [
            choice,
            choice === "skip" ? "Skip to the next phase" : "Stop the plan",
          ])}
          onChange={(onTimeout) => {
            const chosen = ON_TIMEOUT.find((known) => known === onTimeout);
            if (chosen !== undefined) onChange({ ...wait, onTimeout: chosen });
          }}
        />
      </div>
    </fieldset>
  );
}
