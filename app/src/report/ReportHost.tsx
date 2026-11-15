import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Toast } from "../ui";
import { errorStore, type CapturedError, type ErrorStore } from "./capture";
import { registerSensitive, setStorageState } from "./environment";
import { recordEvent, type StorageState, type TransportKind } from "./events";
import { ReportDialog } from "./ReportDialog";

const TRANSPORTS: readonly Exclude<TransportKind, "other">[] = [
  "webserial",
  "webbluetooth",
  "webusb",
  "simulator",
];

/** The transport type of an adapter URL: its scheme, when it is one the app knows, and nothing after it. */
export function transportOf(adapter: string, simulated: boolean): TransportKind {
  if (simulated) return "simulator";
  const scheme = adapter.split("://")[0] ?? "";
  return TRANSPORTS.find((kind) => kind === scheme) ?? "other";
}

function useStateLogging(): void {
  const { state } = useDatabase();
  useEffect(() => {
    const next: StorageState =
      state.status === "ready" ? "ready" : state.status === "opening" ? "opening" : state.problem;
    setStorageState(next);
    recordEvent({ kind: "storage", state: next });
  }, [state]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const record = (): void => {
      recordEvent({
        kind: "service-worker",
        state: navigator.serviceWorker.controller === null ? "uncontrolled" : "controlled",
      });
    };
    record();
    navigator.serviceWorker.addEventListener("controllerchange", record);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", record);
    };
  }, []);
}

function useConnectionLogging(): void {
  const { connection } = useDiagnostics();
  const connected = useRef(false);
  useEffect(() => {
    if (connection === undefined) {
      if (connected.current) recordEvent({ kind: "disconnect" });
      connected.current = false;
      return;
    }
    // Values a report must never carry, wherever an error message might repeat them.
    registerSensitive([
      connection.adapter,
      connection.info.identity,
      connection.info.description,
      connection.info.stnIdentity,
    ]);
    connected.current = true;
    recordEvent({
      kind: "connect",
      transport: transportOf(connection.adapter, connection.simulated),
    });
  }, [connection]);
}

/**
 * Mounted once inside the providers. It keeps the event log informed of the database, service worker and connection, and offers a report for an error no boundary showed (one in an event handler, a worker, a rejected promise or a service call). It renders a notice only; it never reports by itself.
 */
export function ReportHost({ store = errorStore }: { readonly store?: ErrorStore }) {
  useStateLogging();
  useConnectionLogging();
  const { pending } = useSyncExternalStore(store.subscribe, store.getState);
  const [reporting, setReporting] = useState<CapturedError | undefined>(undefined);
  return (
    <>
      <Toast
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) store.dismiss();
        }}
        title="Something went wrong"
        description="The app is still running. You can report what happened; you see the report before anything leaves your device."
        duration={Infinity}
        actions={[
          {
            label: "Report this problem",
            onSelect: () => {
              setReporting(pending);
              store.dismiss();
            },
          },
        ]}
      />
      {reporting !== undefined && (
        <ReportDialog
          open
          onOpenChange={(open) => {
            if (!open) setReporting(undefined);
          }}
          error={reporting}
        />
      )}
    </>
  );
}
