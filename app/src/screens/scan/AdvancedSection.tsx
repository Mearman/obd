import { useReducer } from "react";
import { useDiagnostics } from "../../diagnostics/DiagnosticsProvider";
import { PROFILE_REQUIRED_REASON } from "../../profiles/generic";
import { Collapsible, TextField } from "../../ui";
import { GuardedOperation } from "../GuardedOperation";
import { muted, row } from "../screen.css";
import { INITIAL_ADVANCED_FORM, advancedFormReducer, type AdvancedForm } from "./advanced-form";

const REASON_ID = "advanced-profile-required-reason";

/**
 * Advanced: the operations that change the car (clearing every emissions code, writing a value and running an actuator test), each in two steps behind the read-only guard.
 *
 * The typed fields are held here, in the part that stays mounted, so collapsing the section keeps them.
 *
 * @param defaultExpanded Whether the section starts expanded.
 */
export function AdvancedSection({
  defaultExpanded = false,
}: {
  readonly defaultExpanded?: boolean;
}) {
  const { service, connection, collection } = useDiagnostics();
  const { client } = service;
  const [form, change] = useReducer(advancedFormReducer, INITIAL_ADVANCED_FORM);
  const field = (name: keyof AdvancedForm) => ({
    value: form[name],
    onValueChange: (value: string) => {
      change({ field: name, value });
    },
  });

  const idle = connection !== undefined && collection.run === undefined;
  const generic = connection?.profile === null;
  const unitActions = idle && !generic;

  return (
    <Collapsible title="Advanced: changes to the car" defaultExpanded={defaultExpanded}>
      <p className={muted}>
        Each one is two steps. The first reads the car, saves a snapshot and shows exactly what
        would be sent. Only the second sends it, through the read-only guard&apos;s single-use
        permission.
      </p>
      {generic && (
        <p id={REASON_ID} className={muted}>
          {PROFILE_REQUIRED_REASON} Clearing every emissions code below needs no profile.
        </p>
      )}
      <GuardedOperation
        label="Clear every emissions code (mode 04)"
        title="Clear emissions codes on every unit"
        disabled={!idle}
        request={() => client.clear.request({ target: { kind: "obd" } })}
        confirm={(confirmation) => client.clear.confirm({ confirmation })}
      />
      <TextField label="Unit to change" {...field("unit")} disabled={generic} />
      <TextField
        label="Write request (hexadecimal)"
        {...field("writeRequest")}
        placeholder="3B 99 00 02"
        disabled={generic}
      />
      <TextField
        label="Read request for the same value"
        {...field("writeRead")}
        placeholder="21 99"
        disabled={generic}
      />
      <div className={row}>
        <GuardedOperation
          label="Write a value"
          title="Write a value"
          disabled={!unitActions || form.writeRequest === "" || form.writeRead === ""}
          describedBy={generic ? REASON_ID : undefined}
          request={() =>
            client.write.request({
              unit: form.unit,
              request: form.writeRequest,
              read: form.writeRead,
            })
          }
          confirm={(confirmation) => client.write.confirm({ confirmation })}
        />
      </div>
      <TextField
        label="Actuator start request (hexadecimal)"
        {...field("actuateRequest")}
        placeholder="30 20 07 01"
        disabled={generic}
      />
      <TextField
        label="Actuator stop request (hexadecimal)"
        {...field("actuateStop")}
        placeholder="30 20 00"
        disabled={generic}
      />
      <TextField
        label="Hold for (milliseconds, at most 30000)"
        {...field("actuateMs")}
        inputMode="numeric"
        disabled={generic}
      />
      <div className={row}>
        <GuardedOperation
          label="Run an actuator test"
          title="Run an actuator test"
          disabled={!unitActions || form.actuateRequest === "" || form.actuateStop === ""}
          describedBy={generic ? REASON_ID : undefined}
          request={() =>
            client.actuate.request({
              unit: form.unit,
              request: form.actuateRequest,
              stop: form.actuateStop,
              durationMs: Number(form.actuateMs),
            })
          }
          confirm={(confirmation) => client.actuate.confirm({ confirmation })}
        />
      </div>
    </Collapsible>
  );
}
