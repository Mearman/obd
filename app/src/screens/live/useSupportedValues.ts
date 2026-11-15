import type { Connection } from "obd-read";
import { useEffect, useState } from "react";
import { failureMessage } from "../../diagnostics/client";
import { useDiagnostics } from "../../diagnostics/DiagnosticsProvider";

/** The legislated values a car supports and the time one request took. */
export interface SupportedValues {
  readonly values: readonly {
    readonly name: string;
    readonly columns: readonly { readonly label: string; readonly unit: string }[];
  }[];
  readonly requestMs: number;
}

/** What the screen knows about the values the connected car supports. */
export type SupportedState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly supported: SupportedValues }
  | { readonly status: "failed"; readonly message: string };

/** The list for each connection, so leaving the screen and coming back does not ask the car again. */
const known = new WeakMap<Connection, SupportedValues>();

/**
 * Asks the service which values the connected car supports, once per connection, while `enabled` (the adapter is free). The question goes to the car, so the answer takes a few requests.
 */
export function useSupportedValues(
  connection: Connection | undefined,
  enabled: boolean,
): SupportedState {
  const { service } = useDiagnostics();
  // Only what an answer brought, so no state is set while an effect starts: `loading` is derived.
  const [answer, setAnswer] = useState<
    | { readonly connection: Connection; readonly supported: SupportedValues }
    | { readonly connection: Connection; readonly message: string }
    | undefined
  >(undefined);
  const cached = connection === undefined ? undefined : known.get(connection);
  const needed = connection !== undefined && enabled && cached === undefined;

  useEffect(() => {
    if (!needed) return;
    const live = { active: true };
    void service.client.runs.values().then(
      (supported) => {
        known.set(connection, supported);
        if (live.active) setAnswer({ connection, supported });
      },
      (caught: unknown) => {
        if (live.active) {
          setAnswer({
            connection,
            message: failureMessage(caught, "Could not read the values the car supports."),
          });
        }
      },
    );
    return () => {
      live.active = false;
    };
  }, [connection, needed, service]);

  if (connection === undefined || !enabled) return { status: "idle" };
  if (cached !== undefined) return { status: "ready", supported: cached };
  if (answer?.connection === connection && "message" in answer) {
    return { status: "failed", message: answer.message };
  }
  return { status: "loading" };
}
