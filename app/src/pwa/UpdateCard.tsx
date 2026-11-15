import { muted, stack } from "../screens/screen.css";
import { Button, Card } from "../ui";
import { useUpdates } from "./UpdatesProvider";
import { CHECK_INTERVAL_MS, type UpdateStatus } from "./updater";

const INTERVAL_MINUTES = CHECK_INTERVAL_MS / 60_000;

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** One line saying when the app last looked for an update, or why it could not. */
function checkedText(status: UpdateStatus): string {
  if (!status.supported)
    return "This browser has not registered the app for offline use, so it cannot check for updates.";
  if (status.checking) return "Checking for a new version…";
  const last =
    status.lastChecked === undefined
      ? "It has not checked for a new version yet."
      : `Last checked for a new version on ${WHEN.format(status.lastChecked)}.`;
  return status.problem === undefined ? last : `${last} The latest check failed: ${status.problem}`;
}

/** One line saying whether a new version waits, and what for. */
function readyText(status: UpdateStatus): string | undefined {
  if (!status.ready) return undefined;
  if (status.waitingFor.length === 0) return "A new version is ready and is loading now.";
  const reasons = [...new Set(status.waitingFor)].join(", ");
  return `A new version is ready. It loads by itself once these finish: ${reasons}.`;
}

/** Settings card: the running version, when it last checked for a new one, and a check on demand. */
export function UpdateCard() {
  const { updater, status } = useUpdates();
  const ready = readyText(status);
  return (
    <Card
      title="Version and updates"
      description={`The app looks for a new version every ${String(INTERVAL_MINUTES)} minutes, and whenever this tab is shown again or the browser comes back online. A new version loads by itself when nothing is running.`}
    >
      <div className={stack}>
        <p>Running version {status.version}.</p>
        <p className={muted} role="status">
          {checkedText(status)}
        </p>
        {ready !== undefined && <p>{ready}</p>}
        <Button
          block
          disabled={!status.supported || status.checking}
          onClick={() => {
            void updater.checkNow();
          }}
        >
          Check now
        </Button>
        {status.ready && (
          <Button
            block
            onClick={() => {
              updater.applyNow();
            }}
          >
            Reload onto the new version
          </Button>
        )}
      </div>
    </Card>
  );
}
