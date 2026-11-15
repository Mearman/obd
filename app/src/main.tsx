import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/themes.css";
import "./theme/global.css";
import { App } from "./App";
import { DatabaseProvider } from "./database/DatabaseProvider";
import { exposeForE2e } from "./database/e2e-hook";
import { startDatabaseSession, type DatabaseSession } from "./database/session";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsProvider";
import { ProfilesProvider } from "./profiles/ProfilesProvider";
import { PwaUpdater } from "./pwa/PwaUpdater";
import { errorStore, installGlobalHandlers } from "./report/capture";
import { installE2eFaults } from "./report/e2e-fault";
import { ReportHost, RootBoundary } from "./report";
import { createPageService } from "./service/page-service";
import { StorageBridge } from "./service/StorageBridge";
import { applyThemePreference, readThemePreference } from "./theme/preference";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ToastProvider, TooltipProvider } from "./ui";

// Apply the stored scheme before the first render so a forced theme never flashes the other one.
applyThemePreference(readThemePreference(), document.documentElement);

// Errors React's boundaries cannot see: uncaught errors and rejections on the window.
installGlobalHandlers(window, errorStore);
if (import.meta.env.VITE_OBD_E2E === "1") installE2eFaults();

// One worker per page, started here so React's repeated effects never start a second.
function startSession(): DatabaseSession {
  const session = startDatabaseSession();
  if (import.meta.env.VITE_OBD_E2E === "1") exposeForE2e(session);
  return session;
}
const databaseSession = startSession();
const service = createPageService();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RootBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <DatabaseProvider initial={databaseSession} start={startSession}>
              <StorageBridge source={service.storage} />
              <ProfilesProvider client={service.client}>
                <DiagnosticsProvider service={service}>
                  <ReportHost />
                  <RootBoundary>
                    <App />
                  </RootBoundary>
                </DiagnosticsProvider>
              </ProfilesProvider>
            </DatabaseProvider>
            <PwaUpdater />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </RootBoundary>
  </StrictMode>,
);
