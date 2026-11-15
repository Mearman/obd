import { useState } from "react";
import { detectBrowserSupport, type BrowserSupport } from "./connect/support";
import { DatabaseNotice } from "./database/DatabaseNotice";
import { useDiagnostics } from "./diagnostics/DiagnosticsProvider";
import { app, brand, header, identity, main, nav, status } from "./App.css";
import { ConnectScreen } from "./screens/ConnectScreen";
import { GuideScreen } from "./screens/GuideScreen";
import { LiveScreen } from "./screens/LiveScreen";
import type { LibraryOpen } from "./library/items";
import { LibraryScreen } from "./library/LibraryScreen";
import { ScanScreen } from "./screens/ScanScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { VersionLink } from "./release/VersionLink";
import { ScreenBoundary } from "./report";
import { SAVED_NOTICES, type SavedShare } from "./share/saved";
import { SharedViewer } from "./share/SharedViewer";
import { useSharedLink } from "./share/useSharedLink";
import { THEME_PREFERENCES } from "./theme/preference";
import { useTheme } from "./theme/ThemeProvider";
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger, Toast, Tooltip } from "./ui";

const SCREENS = ["connect", "scan", "live", "library", "guide", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];

const TITLES: Readonly<Record<ScreenName, string>> = {
  connect: "Connect",
  scan: "Scan",
  live: "Live",
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
  const [screen, setScreen] = useState<ScreenName>("connect");
  const { connection } = useDiagnostics();
  const shared = useSharedLink();
  const [saved, setSaved] = useState<SavedShare | undefined>(undefined);
  const goConnect = () => {
    setScreen("connect");
  };
  // Held here, so the Library's viewer stays open when the user looks at another screen and comes back.
  const [opened, setOpened] = useState<LibraryOpen | undefined>(undefined);
  const viewCapture = (id: string): void => {
    setOpened({ kind: "capture", id });
    setScreen("library");
  };
  // A plan from a link, kept in My plans, that the Guide screen opens on ready to record.
  const [offeredPlan, setOfferedPlan] = useState<string | undefined>(undefined);
  const viewRun = (id: string): void => {
    setOpened({ kind: "run", id });
    setScreen("library");
  };

  return (
    <div className={app}>
      <header className={header}>
        <div className={identity}>
          <span className={brand}>obd-read</span>
          <VersionLink />
        </div>
        <div className={status}>
          {shared.fragment === undefined ? (
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
          ) : (
            <Badge tone="warning">Shared data</Badge>
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
          title={SAVED_NOTICES[saved].title}
          description={SAVED_NOTICES[saved].description}
        />
      )}
      {shared.fragment !== undefined ? (
        <main className={main}>
          <ScreenBoundary
            screen="shared"
            resetKeys={[shared.fragment]}
            onGoToConnect={() => {
              shared.clear();
              setScreen("connect");
            }}
          >
            <SharedViewer
              key={shared.fragment}
              fragment={shared.fragment}
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
            <TabsContent value="connect">
              <ScreenBoundary screen="connect">
                <ConnectScreen support={support} onCaptured={viewCapture} />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="scan">
              <ScreenBoundary screen="scan" onGoToConnect={goConnect}>
                <ScanScreen onCaptured={viewCapture} />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="live">
              <ScreenBoundary screen="live" onGoToConnect={goConnect}>
                <LiveScreen />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="library">
              <ScreenBoundary screen="library" onGoToConnect={goConnect}>
                <LibraryScreen open={opened} onOpen={setOpened} />
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
