import { Button } from "../ui";
import { error } from "../screens/screen.css";
import { useDatabase, type DatabaseProblem } from "./DatabaseProvider";

const EXPLANATIONS: Readonly<Record<DatabaseProblem, string>> = {
  "in-use":
    "obd-read is already open in another tab or window, and only one can use the stored data at a time. Close the other one, then try again.",
  unsupported:
    "This browser cannot store data on this device, so runs and scans will not be saved.",
  failed: "The stored data could not be opened, so runs and scans will not be saved.",
};

/** A notice at the top of the app when the database is unavailable, with a retry for the other-tab case. Renders nothing otherwise. */
export function DatabaseNotice() {
  const { state, retry } = useDatabase();
  if (state.status !== "unavailable") return null;
  return (
    <div className={error} role="alert">
      <p>{EXPLANATIONS[state.problem]}</p>
      {state.problem === "failed" && <p>{state.message}</p>}
      {state.problem !== "unsupported" && <Button onClick={retry}>Try again</Button>}
    </div>
  );
}
