import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/themes.css";
import "./theme/global.css";
import { RouterProvider } from "@tanstack/react-router";
import { App } from "./App";
import { DatabaseProvider } from "./database/DatabaseProvider";
import { exposeForE2e } from "./database/e2e-hook";
import { startDatabaseSession, type DatabaseSession } from "./database/session";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsProvider";
import { ProfilesProvider } from "./profiles/ProfilesProvider";
import { createActivityRegistry, followActivity } from "./pwa/activity";
import { ActivityProvider } from "./pwa/ActivityProvider";
import { browserClock, browserPage, sessionReloadMemory } from "./pwa/browser";
import { DatabaseCatchUp } from "./pwa/DatabaseCatchUp";
import { PwaUpdater } from "./pwa/PwaUpdater";
import { createUpdater, VERSION_CHANNEL } from "./pwa/updater";
import { UpdatesProvider } from "./pwa/UpdatesProvider";
import { APP_VERSION } from "./release/release";
import { errorStore, installGlobalHandlers } from "./report/capture";
import { installE2eFaults } from "./report/e2e-fault";
import { ReportHost, RootBoundary } from "./report";
import { createAppRouter } from "./router/router";
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

// What runs in this tab, which an update waits for, and the updater that reads it.
const activity = createActivityRegistry();
const updater = createUpdater({
  version: APP_VERSION,
  clock: browserClock,
  page: browserPage(),
  activity,
  channel: new BroadcastChannel(VERSION_CHANNEL),
  memory: sessionReloadMemory(),
});

// One worker per page, started here so React's repeated effects never start a second. Its calls in flight are an activity for as long as the session lives.
function startSession(): DatabaseSession {
  const session = startDatabaseSession();
  if (import.meta.env.VITE_OBD_E2E === "1") exposeForE2e(session);
  const unfollow = followActivity(activity, "saving or reading stored data", session);
  return {
    ...session,
    close: () => {
      unfollow();
      session.close();
    },
  };
}
const databaseSession = startSession();
const service = createPageService();

const router = createAppRouter(App, { basepath: import.meta.env.BASE_URL });

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RootBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <ActivityProvider registry={activity}>
              <UpdatesProvider updater={updater}>
                <DatabaseProvider initial={databaseSession} start={startSession}>
                  <DatabaseCatchUp />
                  <StorageBridge source={service.storage} />
                  <ProfilesProvider client={service.client}>
                    <DiagnosticsProvider service={service}>
                      <ReportHost />
                      <RootBoundary>
                        <RouterProvider router={router} />
                      </RootBoundary>
                    </DiagnosticsProvider>
                  </ProfilesProvider>
                </DatabaseProvider>
                <PwaUpdater />
              </UpdatesProvider>
            </ActivityProvider>
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </RootBoundary>
  </StrictMode>,
);
