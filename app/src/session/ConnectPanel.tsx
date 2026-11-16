import type { Connection } from "obd-read";
import { useState } from "react";
import { adapterAvailability } from "../connect/availability";
import type { BrowserSupport } from "../connect/support";
import { failureMessage, type AdapterKind } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { GENERIC_SUMMARY, profileTitle } from "../profiles/generic";
import { ProfilePicker } from "../profiles/ProfilePicker";
import { ProfileSuggestions } from "../profiles/ProfileSuggestions";
import { useProfiles } from "../profiles/ProfilesProvider";
import { Button, Card, Dialog, Switch } from "../ui";
import { error, list, muted, optionGrid } from "../screens/screen.css";
import { details } from "./session.css";

interface Option {
  readonly kind: AdapterKind;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

const OPTIONS: readonly Option[] = [
  {
    kind: "webbluetooth",
    title: "Bluetooth LE adapter",
    description: "Adapters such as the vLinker FD+. You pick the device in your browser's prompt.",
    action: "Connect with Bluetooth LE",
  },
  {
    kind: "webserial",
    title: "USB or serial adapter",
    description:
      "USB adapters and paired Bluetooth serial adapters, chosen in your browser's prompt.",
    action: "Connect with USB or serial",
  },
  {
    kind: "simulator",
    title: "Simulator",
    description:
      "A car simulated inside the app: invented values and no hardware, to try every screen.",
    action: "Connect with the simulator",
  },
];

/**
 * The Connection section: choose a vehicle profile and how to reach the car, with clear reasons when this browser cannot; once connected, what the adapter said about itself and, after a generic read, the profiles its VIN suggests.
 */
export function ConnectPanel({ support }: { readonly support: BrowserSupport }) {
  const { connection, connect, profile, setProfile } = useDiagnostics();
  const { builtin, imported } = useProfiles();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<AdapterKind | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const availability = adapterAvailability(support.capabilities, support.family);

  async function choose(kind: AdapterKind): Promise<void> {
    setBusy(kind);
    setProblem(undefined);
    try {
      await connect(kind, showAll);
    } catch (caught) {
      setProblem(failureMessage(caught, "The connection failed."));
    } finally {
      setBusy(undefined);
    }
  }

  if (connection !== undefined) {
    return (
      <>
        <Card title="This connection">
          <dl className={details}>
            <dt>Through</dt>
            <dd>{connectionLabel(connection)}</dd>
            <dt>Profile</dt>
            <dd>{profileTitle(connection.profile)}</dd>
            <dt>Adapter</dt>
            <dd>{connection.info.identity}</dd>
            {connection.info.description !== null && (
              <>
                <dt>Description</dt>
                <dd>{connection.info.description}</dd>
              </>
            )}
            {connection.info.stnIdentity !== null && (
              <>
                <dt>STN chip</dt>
                <dd>{connection.info.stnIdentity}</dd>
              </>
            )}
            <dt>Battery at connection</dt>
            <dd>{connection.info.voltage ?? "Not reported"}</dd>
          </dl>
          <p className={muted}>
            Disconnect from the bar above to choose another profile or adapter.
          </p>
        </Card>
        <ProfileSuggestions />
      </>
    );
  }

  return (
    <>
      <Card
        title="Vehicle"
        description="A profile names the control units to talk to. Generic OBD-II needs none. Choose before connecting."
      >
        <ProfilePicker
          builtin={builtin}
          imported={imported}
          value={profile}
          onValueChange={setProfile}
        />
        {profile === undefined && <p className={muted}>{GENERIC_SUMMARY}</p>}
      </Card>

      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}

      <div className={optionGrid}>
        {OPTIONS.map((option) => {
          const state = availability[option.kind];
          const reasonId = `reason-${option.kind}`;
          return (
            <Card key={option.kind} title={option.title} description={option.description}>
              {state.reason !== undefined && (
                <p id={reasonId} className={muted}>
                  {state.reason}
                </p>
              )}
              <Button
                variant={option.kind === "simulator" ? "secondary" : "primary"}
                block
                disabled={!state.available || busy !== undefined}
                {...(state.reason === undefined ? {} : { "aria-describedby": reasonId })}
                onClick={() => void choose(option.kind)}
              >
                {busy === option.kind ? "Connecting…" : option.action}
              </Button>
            </Card>
          );
        })}
      </div>

      <Card title="Options">
        <Switch
          label="List every nearby Bluetooth device, not only known adapter names"
          checked={showAll}
          onCheckedChange={setShowAll}
        />
      </Card>

      <Dialog
        trigger={<Button variant="ghost">Which browsers work?</Button>}
        title="Browser support"
        description="Connecting to a real adapter needs Chrome or Edge on Android or a computer, on a page served over HTTPS or from localhost."
      >
        {support.capabilities.issues.length === 0 ? (
          <p className={muted}>This browser supports both Web Serial and Web Bluetooth.</p>
        ) : (
          <ul className={list}>
            {support.capabilities.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <p className={muted}>
          Safari, Firefox and every iPhone or iPad browser cannot use either API.
        </p>
      </Dialog>
    </>
  );
}

/** What the connection is called: Simulator, or the adapter the person chose. */
export function connectionLabel(connection: Connection): string {
  return connection.simulated ? "Simulator" : adapterLabel(connection.adapter);
}

/** The adapter URL's target, which is the name the user knows the adapter by. */
function adapterLabel(adapter: string): string {
  const target = adapter.slice(adapter.indexOf("://") + 3).split("?")[0];
  return target === undefined || target === "" ? adapter : target;
}
