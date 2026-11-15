import { useState } from "react";
import { adapterAvailability } from "../connect/availability";
import type { BrowserSupport } from "../connect/support";
import { CaptureCard } from "../captures/CaptureCard";
import { failureMessage, type AdapterKind } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { GENERIC_SUMMARY, profileTitle } from "../profiles/generic";
import { ProfilePicker } from "../profiles/ProfilePicker";
import { useProfiles } from "../profiles/ProfilesProvider";
import { Badge, Button, Card, Dialog, Switch } from "../ui";
import { error, list, muted, optionGrid, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

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
 * Connect: choose how to reach the car, with clear reasons when this browser cannot, and capture everything once connected.
 *
 * @param onCaptured Called with a capture's id once it is stored, to open it.
 */
export function ConnectScreen({
  support,
  onCaptured,
}: {
  readonly support: BrowserSupport;
  readonly onCaptured?: (id: string) => void;
}) {
  const { connection, connect, disconnect, profile, setProfile } = useDiagnostics();
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

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Connect</ScreenHeading>

      {connection !== undefined && (
        <Card
          title={`Connected to ${connection.simulated ? "Simulator" : adapterLabel(connection.adapter)}`}
          description={`Profile: ${profileTitle(connection.profile)}. Adapter ${connection.info.identity}.`}
        >
          <div>
            <Badge tone={connection.simulated ? "simulated" : "success"}>
              {connection.simulated ? "Simulator" : "Connected"}
            </Badge>
          </div>
          <Button block onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </Card>
      )}

      <Card
        title="Vehicle"
        description="A profile names the control units to talk to. Generic OBD-II needs none. Choose before connecting."
      >
        <ProfilePicker
          builtin={builtin}
          imported={imported}
          value={profile}
          onValueChange={setProfile}
          disabled={connection !== undefined}
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
                disabled={!state.available || busy !== undefined || connection !== undefined}
                {...(state.reason === undefined ? {} : { "aria-describedby": reasonId })}
                onClick={() => void choose(option.kind)}
              >
                {busy === option.kind ? "Connecting…" : option.action}
              </Button>
            </Card>
          );
        })}
      </div>

      {connection !== undefined && (
        <CaptureCard {...(onCaptured === undefined ? {} : { onSaved: onCaptured })} />
      )}

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
    </div>
  );
}

/** The adapter URL's target, which is the name the user knows the adapter by. */
function adapterLabel(adapter: string): string {
  const target = adapter.slice(adapter.indexOf("://") + 3).split("?")[0];
  return target === undefined || target === "" ? adapter : target;
}
