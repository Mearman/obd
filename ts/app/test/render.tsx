import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { DiagnosticsProvider } from "../src/diagnostics/DiagnosticsProvider";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import { createSimulatorClient } from "../src/diagnostics/simulator";
import { ProfilesProvider } from "../src/profiles/ProfilesProvider";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { ToastProvider, TooltipProvider } from "../src/ui";

/** Renders `ui` inside every provider the app has, with the simulator unless a client is given. */
export function renderApp(ui: ReactElement, client: DiagnosticsClient = createSimulatorClient()) {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <DiagnosticsProvider client={client}>
            <ProfilesProvider>{ui}</ProfilesProvider>
          </DiagnosticsProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}
