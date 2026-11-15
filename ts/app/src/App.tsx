import { useState } from "react";
import { detectBrowserSupport, type BrowserSupport } from "./connect/support";
import { DatabaseNotice } from "./database/DatabaseNotice";
import { useDiagnostics } from "./diagnostics/DiagnosticsProvider";
import { app, brand, header, main, nav, status } from "./App.css";
import { ConnectScreen } from "./screens/ConnectScreen";
import { LiveScreen } from "./screens/LiveScreen";
import { RunsScreen } from "./screens/RunsScreen";
import { ScanScreen } from "./screens/ScanScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { THEME_PREFERENCES } from "./theme/preference";
import { useTheme } from "./theme/ThemeProvider";
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "./ui";

const SCREENS = ["connect", "scan", "live", "runs", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];

const TITLES: Readonly<Record<ScreenName, string>> = {
  connect: "Connect",
  scan: "Scan",
  live: "Live",
  runs: "Runs",
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

/** The application shell: header, five screens and the navigation between them. */
export function App({ support = detectBrowserSupport() }: { readonly support?: BrowserSupport }) {
  const [screen, setScreen] = useState<ScreenName>("connect");
  const { connection } = useDiagnostics();

  return (
    <div className={app}>
      <header className={header}>
        <span className={brand}>obd-read</span>
        <div className={status}>
          <Badge
            tone={
              connection === undefined ? "neutral" : connection.simulated ? "simulated" : "success"
            }
          >
            {connection === undefined
              ? "Not connected"
              : connection.simulated
                ? "Simulator"
                : "Connected"}
          </Badge>
          <ThemeButton />
        </div>
      </header>
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
            <ConnectScreen support={support} />
          </TabsContent>
          <TabsContent value="scan">
            <ScanScreen />
          </TabsContent>
          <TabsContent value="live">
            <LiveScreen />
          </TabsContent>
          <TabsContent value="runs">
            <RunsScreen />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsScreen />
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
    </div>
  );
}
