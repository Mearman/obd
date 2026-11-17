import { useState } from "react";
import { SCREEN_NAMES as SCREENS, type ScreenName } from "./router/search";
import { useAppLocation } from "./screens/useAppLocation";
import { detectBrowserSupport, type BrowserSupport } from "./connect/support";
import { DatabaseNotice } from "./database/DatabaseNotice";
import { useDiagnostics } from "./diagnostics/DiagnosticsProvider";
import { app, brand, header, identity, main, nav, status } from "./App.css";
import { GuideScreen } from "./screens/GuideScreen";
import { itemKey, type LibraryOpen } from "./library/items";
import { openItemEnvelope } from "./library/item-envelope";
import { LibraryScreen } from "./library/LibraryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SessionScreen } from "./session/SessionScreen";
import { VersionLink } from "./release/VersionLink";
import { ScreenBoundary } from "./report";
import { savedNotice, type SavedShare } from "./share/saved";
import { SharedViewer } from "./share/SharedViewer";
import { useItemAddress } from "./share/useItemAddress";
import { useSharedLink } from "./share/useSharedLink";
import { THEME_PREFERENCES } from "./theme/preference";
import { useTheme } from "./theme/ThemeProvider";
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger, Toast, Tooltip } from "./ui";

const TITLES: Readonly<Record<ScreenName, string>> = {
  session: "Session",
  library: "Library",
  guide: "Guide",
  settings: "Settings",
};

function isScreen(value: string): value is ScreenName {
  return SCREENS.some((name) => name === value);
}

function ThemeButton() {
  const { preference, setPreference } = useTheme();
  const next =
    THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length] ??
    "system";
  return (
    <Tooltip text={`Colour scheme: ${preference}. Press to use ${next}.`}>
      <Button
        variant="ghost"
        onClick={() => {
          setPreference(next);
        }}
      >
        Theme: {preference}
      </Button>
    </Tooltip>
  );
}

/** The application shell: header, the screens and the navigation between them. */
export function App({ support = detectBrowserSupport() }: { readonly support?: BrowserSupport }) {
  const [{ screen, opened, view }, navigate, setShareFragment] = useAppLocation();
  const setScreen = (next: ScreenName): void => {
    navigate({ screen: next });
  };
  const { connection, service } = useDiagnostics();
  const shared = useSharedLink();
  // The open item's address is its sharing link. A link whose item this device does not hold carries someone else's data, so it opens as shared data instead.
  const onLibraryItem = screen === "library" && opened !== undefined;
  const local = useItemAddress(
    onLibraryItem ? itemKey(opened) : undefined,
    () => openItemEnvelope(service.client, opened ?? { kind: "run", id: "" }, Date.now()),
    setShareFragment,
  );
  const resolving = shared.fragment !== undefined && onLibraryItem && local === "loading";
  const sharedFragment = onLibraryItem && local !== "missing" ? undefined : shared.fragment;
  const [saved, setSaved] = useState<SavedShare | undefined>(undefined);
  // Each increment asks the Session screen to show its Connection section.
  const [connectRequest, setConnectRequest] = useState(0);
  const goConnect = () => {
    setScreen("session");
    setConnectRequest((count) => count + 1);
  };
  // The open item lives in the address, so it has a link of its own and Back closes it.
  const setOpened = (open: LibraryOpen | undefined): void => {
    navigate({ screen: "library", opened: open });
  };
  const viewCapture = (id: string): void => {
    setOpened({ kind: "capture", id });
  };
  // A plan from a link, kept in My plans, that the Guide screen opens on ready to record.
  const [offeredPlan, setOfferedPlan] = useState<string | undefined>(undefined);
  const viewRun = (id: string): void => {
    setOpened({ kind: "run", id });
  };

  return (
    <div className={app}>
      <header className={header}>
        <div className={identity}>
          <span className={brand}>obd-read</span>
          <VersionLink />
        </div>
        <div className={status}>
          {/* The Session screen's own bar shows the connection there, with the adapter and Disconnect; the header shows it everywhere else. Shared data is marked on every screen. */}
          {sharedFragment !== undefined ? (
            <Badge tone="warning">Shared data</Badge>
          ) : (
            screen !== "session" && (
              <Badge
                tone={
                  connection === undefined
                    ? "neutral"
                    : connection.simulated
                      ? "simulated"
                      : "success"
                }
              >
                {connection === undefined
                  ? "Not connected"
                  : connection.simulated
                    ? "Simulator"
                    : "Connected"}
              </Badge>
            )
          )}
          <ThemeButton />
        </div>
      </header>
      {saved !== undefined && (
        <Toast
          open
          onOpenChange={(open) => {
            if (!open) setSaved(undefined);
          }}
          title={savedNotice(saved).title}
          description={savedNotice(saved).description}
        />
      )}
      {resolving ? (
        <main className={main} aria-busy />
      ) : sharedFragment !== undefined ? (
        <main className={main}>
          <ScreenBoundary
            screen="shared"
            resetKeys={[sharedFragment]}
            onGoToConnect={() => {
              shared.clear();
              goConnect();
            }}
          >
            <SharedViewer
              key={sharedFragment}
              fragment={sharedFragment}
              onDone={(kept) => {
                shared.clear();
                setSaved(kept);
              }}
              onOpenPlan={(planId) => {
                shared.clear();
                setOfferedPlan(planId);
                setScreen("guide");
              }}
            />
          </ScreenBoundary>
        </main>
      ) : (
        <Tabs
          value={screen}
          onValueChange={(value) => {
            if (isScreen(value)) setScreen(value);
          }}
          style={{ display: "contents" }}
        >
          <main className={main}>
            <DatabaseNotice />
            {/* Kept mounted while another screen shows, so a scan's results and typed fields survive a visit to the Library. */}
            <TabsContent value="session" forceMount hidden={screen !== "session"}>
              <ScreenBoundary screen="session" onGoToConnect={goConnect}>
                <SessionScreen
                  support={support}
                  onCaptured={viewCapture}
                  connectRequest={connectRequest}
                />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="library">
              <ScreenBoundary screen="library" onGoToConnect={goConnect}>
                <LibraryScreen
                  open={opened}
                  onOpen={setOpened}
                  view={view}
                  onView={(next, replace) => {
                    navigate({ screen: "library", view: next, replace });
                  }}
                />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="guide">
              <ScreenBoundary screen="guide" onGoToConnect={goConnect}>
                <GuideScreen onOpenRun={viewRun} offeredPlan={offeredPlan} />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="settings">
              <ScreenBoundary screen="settings" onGoToConnect={goConnect}>
                <SettingsScreen />
              </ScreenBoundary>
            </TabsContent>
          </main>
          <TabsList className={nav} aria-label="Screens">
            {SCREENS.map((name) => (
              <TabsTrigger key={name} value={name}>
                {TITLES[name]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
    </div>
  );
}
