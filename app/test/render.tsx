import { RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import {
  MemoryStorage,
  composeTransportHosts,
  createDiagnosticsService,
  profileLoader,
  simulatorTransportHost,
  type DiagnosticsService,
  type PlanClock,
} from "obd-read";
import { shippedPlans } from "obd-read/plans";
import { builtinProfileData } from "obd-read/profiles";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { DatabaseProvider } from "../src/database/DatabaseProvider";
import type { DatabaseSession } from "../src/database/session";
import type { AppService, PageDevices } from "../src/diagnostics/client";
import { DiagnosticsProvider } from "../src/diagnostics/DiagnosticsProvider";
import { ProfilesProvider } from "../src/profiles/ProfilesProvider";
import { ActivityProvider } from "../src/pwa/ActivityProvider";
import { UpdatesProvider } from "../src/pwa/UpdatesProvider";
import { APP_VERSION } from "../src/release/release";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { createAppRouter } from "../src/router/router";
import { ToastProvider, TooltipProvider } from "../src/ui";
import { readySession } from "./fake-database";
import { openFakeTab, type FakeTab } from "./fake-updates";

/** A service in this process over in-memory storage and the simulated car, with spies where the page would show a picker. */
export interface TestService extends AppService {
  readonly storage: MemoryStorage;
  readonly service: DiagnosticsService;
  readonly devices: {
    [Method in keyof PageDevices]: ReturnType<typeof vi.fn<PageDevices[Method]>>;
  };
}

/** Builds a service that polls quickly, so a test sees readings without waiting; recording plans run on `planClock` when one is given. */
export function createTestService(
  storage = new MemoryStorage(),
  options: { readonly planClock?: PlanClock } = {},
): TestService {
  const loadProfile = profileLoader(storage, builtinProfileData);
  const service = createDiagnosticsService({
    toolVersion: "test",
    storage,
    loadProfile,
    transports: composeTransportHosts(simulatorTransportHost(loadProfile)),
    timing: { pollMs: 5, flushMs: 0, batchSize: 1, reconnectDelay: () => 0 },
    plans: shippedPlans,
    ...(options.planClock === undefined ? {} : { planClock: options.planClock }),
  });
  return {
    storage,
    service,
    client: service.host.client,
    devices: {
      prepare: vi.fn<PageDevices["prepare"]>(() => Promise.resolve()),
      chooseSerial: vi.fn<PageDevices["chooseSerial"]>(() =>
        Promise.resolve({ scheme: "webserial" as const }),
      ),
    },
  };
}

/** Renders `ui` inside every provider the app has, over a fresh simulated service unless one is given, a ready in-memory database unless a session is, and an updater on a fake service worker registration unless a tab is given. */
export async function renderApp(
  ui: ReactElement,
  service: AppService = createTestService(),
  database: DatabaseSession = readySession(),
  restart: () => DatabaseSession = readySession,
  tab: FakeTab = openFakeTab(APP_VERSION),
) {
  const router = createAppRouter(() => ui);
  // The router reads the address before it renders, so the page is there when this resolves.
  await router.load();
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <ActivityProvider registry={tab.activity}>
            <UpdatesProvider updater={tab.updater}>
              <DatabaseProvider initial={database} start={restart}>
                <ProfilesProvider client={service.client}>
                  <DiagnosticsProvider service={service}>
                    <RouterProvider router={router} />
                  </DiagnosticsProvider>
                </ProfilesProvider>
              </DatabaseProvider>
            </UpdatesProvider>
          </ActivityProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}
