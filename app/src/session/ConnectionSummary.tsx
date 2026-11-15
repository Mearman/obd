import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { profileTitle } from "../profiles/generic";
import { error, muted } from "../screens/screen.css";
import { Button } from "../ui";
import { connectionLabel } from "./ConnectPanel";
import { summary, summaryPart, summaryText } from "./session.css";

/** The connection in one line: the adapter, the profile and the battery voltage read when it connected, with Disconnect; or that there is none. */
export function ConnectionSummary() {
  const { connection, disconnect } = useDiagnostics();
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (connection === undefined) {
    return (
      <div className={summary}>
        <p className={`${summaryText} ${muted}`}>Not connected</p>
      </div>
    );
  }

  async function leave(): Promise<void> {
    setProblem(undefined);
    try {
      await disconnect();
    } catch (caught) {
      setProblem(failureMessage(caught, "Could not disconnect."));
    }
  }

  return (
    <>
      <div className={summary}>
        <p className={summaryText}>
          <span className={summaryPart}>Connected to {connectionLabel(connection)}</span>
          <span className={summaryPart}>Profile: {profileTitle(connection.profile)}</span>
          {connection.info.voltage !== null && (
            <span className={summaryPart}>Battery {connection.info.voltage}</span>
          )}
        </p>
        <Button onClick={() => void leave()}>Disconnect</Button>
      </div>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
    </>
  );
}
