import { useId } from "react";
import { field, input, label } from "./TextField.css";

/** Props of {@link TextField}. */
export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  /** Inputmode hint for the on-screen keyboard. */
  readonly inputMode?: "text" | "numeric";
}

/** A labelled single-line text input with a 44 px touch target. */
export function TextField({
  label: text,
  value,
  onValueChange,
  placeholder,
  inputMode = "text",
}: TextFieldProps) {
  const id = useId();
  return (
    <div className={field}>
      <label htmlFor={id} className={label}>
        {text}
      </label>
      <input
        id={id}
        className={input}
        value={value}
        inputMode={inputMode}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
