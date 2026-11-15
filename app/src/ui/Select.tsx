import * as RadixSelect from "@radix-ui/react-select";
import { useId } from "react";
import { content, field, item, label, trigger } from "./Select.css";

/** One choice of a {@link Select}. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** Props of {@link Select}. */
export interface SelectProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
}

/** A labelled single-choice select with 44 px rows, built on Radix so it works by keyboard too. */
export function Select({ label: text, value, options, onValueChange, disabled }: SelectProps) {
  const id = useId();
  const current = options.find((option) => option.value === value);
  return (
    <div className={field}>
      <label htmlFor={id} className={label}>
        {text}
      </label>
      <RadixSelect.Root
        value={value}
        onValueChange={onValueChange}
        {...(disabled === undefined ? {} : { disabled })}
      >
        <RadixSelect.Trigger id={id} className={trigger}>
          <span>{current?.label ?? value}</span>
          <RadixSelect.Icon aria-hidden>▾</RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content className={content} position="popper" sideOffset={4}>
            <RadixSelect.Viewport>
              {options.map((option) => (
                <RadixSelect.Item key={option.value} value={option.value} className={item}>
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
