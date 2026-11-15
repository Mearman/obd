import * as RadixSwitch from "@radix-ui/react-switch";
import { useId, type ReactNode } from "react";
import { field, label, root, thumb } from "./Switch.css";

/** Props of {@link Switch}. */
export interface SwitchProps {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

/** A labelled on/off switch. The label is part of the control, so the whole row names it. */
export function Switch({ label: text, checked, onCheckedChange, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className={field}>
      <label htmlFor={id} className={label}>
        {text}
      </label>
      <RadixSwitch.Root
        id={id}
        className={root}
        checked={checked}
        onCheckedChange={onCheckedChange}
        {...(disabled === undefined ? {} : { disabled })}
      >
        <RadixSwitch.Thumb className={thumb} />
      </RadixSwitch.Root>
    </div>
  );
}
