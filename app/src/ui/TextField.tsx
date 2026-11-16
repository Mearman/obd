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
  /** The kind of input: free text, or a day picked from the browser's calendar as `YYYY-MM-DD`. */
  readonly type?: "text" | "date";
  readonly disabled?: boolean;
  /** Called when the field loses focus. */
  readonly onBlur?: () => void;
}

/** A labelled single-line text input with a 44 px touch target. */
export function TextField({
  label: text,
  value,
  onValueChange,
  placeholder,
  inputMode = "text",
  type = "text",
  disabled,
  onBlur,
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
        type={type}
        value={value}
        inputMode={inputMode}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(disabled === undefined ? {} : { disabled })}
        {...(onBlur === undefined ? {} : { onBlur })}
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
