import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/themes.css";
import "./theme/global.css";
import { App } from "./App";
import { createSimulatorClient } from "./diagnostics/simulator";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsProvider";
import { ProfilesProvider } from "./profiles/ProfilesProvider";
import { PwaUpdater } from "./pwa/PwaUpdater";
import { applyThemePreference, readThemePreference } from "./theme/preference";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ToastProvider, TooltipProvider } from "./ui";

// Apply the stored scheme before the first render so a forced theme never flashes the other one.
applyThemePreference(readThemePreference(), document.documentElement);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <DiagnosticsProvider client={createSimulatorClient()}>
            <ProfilesProvider>
              <App />
            </ProfilesProvider>
          </DiagnosticsProvider>
          <PwaUpdater />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
