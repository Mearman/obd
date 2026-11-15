/** What the person has typed into the Advanced section's fields. */
export interface AdvancedForm {
  /** The control unit a write or an actuator test addresses. */
  readonly unit: string;
  readonly writeRequest: string;
  /** The read request for the value the write changes, read before and after it. */
  readonly writeRead: string;
  readonly actuateRequest: string;
  readonly actuateStop: string;
  /** How long the actuator is held, in milliseconds, as typed. */
  readonly actuateMs: string;
}

/** One field changed. */
export interface AdvancedFormChange {
  readonly field: keyof AdvancedForm;
  readonly value: string;
}

/** The fields before anything is typed. */
export const INITIAL_ADVANCED_FORM: AdvancedForm = {
  unit: "engine",
  writeRequest: "",
  writeRead: "",
  actuateRequest: "",
  actuateStop: "",
  actuateMs: "1000",
};

/** Applies one field's change. */
export function advancedFormReducer(form: AdvancedForm, change: AdvancedFormChange): AdvancedForm {
  return { ...form, [change.field]: change.value };
}
