import { useEffect, useState } from "react";
import type { LiveFrame, LiveValue } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { DataTable, type Column } from "../ui";
import { muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const COLUMNS: readonly Column<LiveValue>[] = [
  { header: "Value", render: (row) => row.label },
  { header: "Reading", render: (row) => String(row.value) },
  { header: "Unit", render: (row) => row.unit },
];

/** Live values: streams frames from the client while connected and the screen is shown. */
export function LiveScreen() {
  const { client, connection } = useDiagnostics();
  const [frame, setFrame] = useState<LiveFrame | undefined>(undefined);
  const connected = connection !== undefined;

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void (async () => {
      for await (const next of client.liveValues(controller.signal)) setFrame(next);
    })();
    return () => {
      controller.abort();
      setFrame(undefined);
    };
  }, [client, connected]);

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Live values</ScreenHeading>
      {frame === undefined ? (
        <p className={muted}>
          {connected ? "Waiting for the first reading…" : "Connect an adapter to see live values."}
        </p>
      ) : (
        <DataTable
          label="Live values"
          columns={COLUMNS}
          rows={frame.values}
          rowKey={(row) => row.name}
        />
      )}
    </div>
  );
}
