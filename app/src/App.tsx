import { useState } from "react";
import { detectBrowserSupport, type BrowserSupport } from "./connect/support";
import { DatabaseNotice } from "./database/DatabaseNotice";
import { useDiagnostics } from "./diagnostics/DiagnosticsProvider";
import { app, brand, header, identity, main, nav, status } from "./App.css";
import { CapturesScreen } from "./screens/CapturesScreen";
import { ConnectScreen } from "./screens/ConnectScreen";
import { LiveScreen } from "./screens/LiveScreen";
import { RunsScreen } from "./screens/RunsScreen";
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

const SCREENS = ["connect", "scan", "live", "runs", "captures", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];

const TITLES: Readonly<Record<ScreenName, string>> = {
  connect: "Connect",
  scan: "Scan",
  live: "Live",
  runs: "Runs",
  captures: "Captures",
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
  // Held here, so the viewer stays open when the user looks at another screen and comes back.
  const [openCapture, setOpenCapture] = useState<string | undefined>(undefined);
  const viewCapture = (id: string): void => {
    setOpenCapture(id);
    setScreen("captures");
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
            <TabsContent value="runs">
              <ScreenBoundary screen="runs" onGoToConnect={goConnect}>
                <RunsScreen />
              </ScreenBoundary>
            </TabsContent>
            <TabsContent value="captures">
              <ScreenBoundary screen="captures" onGoToConnect={goConnect}>
                <CapturesScreen open={openCapture} onOpen={setOpenCapture} />
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
