import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { DatabaseProvider } from "../src/database/DatabaseProvider";
import type { DatabaseSession } from "../src/database/session";
import { DiagnosticsProvider } from "../src/diagnostics/DiagnosticsProvider";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import { createSimulatorClient } from "../src/diagnostics/simulator";
import { ProfilesProvider } from "../src/profiles/ProfilesProvider";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { ToastProvider, TooltipProvider } from "../src/ui";
import { readySession } from "./fake-database";

/** Renders `ui` inside every provider the app has, with the simulator unless a client is given and a ready in-memory database unless a session is. */
export function renderApp(
  ui: ReactElement,
  client: DiagnosticsClient = createSimulatorClient(),
  database: DatabaseSession = readySession(),
  restart: () => DatabaseSession = readySession,
) {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <DiagnosticsProvider client={client}>
            <DatabaseProvider initial={database} start={restart}>
              <ProfilesProvider>{ui}</ProfilesProvider>
            </DatabaseProvider>
          </DiagnosticsProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}
