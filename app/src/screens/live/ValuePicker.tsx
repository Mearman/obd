import { Button } from "../../ui";
import { muted } from "../screen.css";
import { describeCycle } from "./estimate";
import { VALUE_GROUPS, groupOf } from "./groups";
import { box, check, checkText, checks, estimate, group, groupTitle, presets } from "./live.css";
import { PRESETS, presetOf } from "./presets";
import type { SupportedValues } from "./useSupportedValues";

/** Props of {@link ValuePicker}. */
export interface ValuePickerProps {
  readonly supported: SupportedValues;
  /** The names chosen. */
  readonly selected: readonly string[];
  readonly onSelectedChange: (names: readonly string[]) => void;
}

/**
 * Which values a run records: presets, then a checklist of what the car supports under the same headings the readings use, and how long one round takes at the adapter's measured speed.
 */
export function ValuePicker({ supported, selected, onSelectedChange }: ValuePickerProps) {
  const names = supported.values.map((value) => value.name);
  const active = presetOf(selected, names);
  const toggle = (name: string): void => {
    onSelectedChange(
      selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name],
    );
  };
  return (
    <>
      <div className={presets} role="group" aria-label="Presets">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant={active === preset ? "primary" : "secondary"}
            aria-pressed={active === preset}
            onClick={() => {
              onSelectedChange(preset.select(names));
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      {VALUE_GROUPS.map((heading) => {
        const members = supported.values.filter((value) => {
          const label = value.columns[0]?.label ?? value.name;
          return groupOf(label) === heading;
        });
        if (members.length === 0) return null;
        return (
          <fieldset key={heading} className={group}>
            <legend className={groupTitle}>{heading}</legend>
            <div className={checks}>
              {members.map((value) => {
                const selectedNow = selected.includes(value.name);
                const label = value.columns.map((column) => column.label).join(", ");
                return (
                  <button
                    key={value.name}
                    type="button"
                    role="checkbox"
                    aria-checked={selectedNow}
                    className={check}
                    onClick={() => {
                      toggle(value.name);
                    }}
                  >
                    <span className={box} aria-hidden="true" />
                    <span className={checkText}>{label}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <p className={estimate}>{describeCycle(selected.length, supported.requestMs)}</p>
      {selected.length === 0 && <p className={muted}>Nothing is chosen, so a run cannot start.</p>}
    </>
  );
}
