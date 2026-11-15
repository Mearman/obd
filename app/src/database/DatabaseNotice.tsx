import { Button } from "../ui";
import { error } from "../screens/screen.css";
import { useDatabase, type DatabaseProblem } from "./DatabaseProvider";
import { unavailableBecause } from "./problem";

const CONSEQUENCES: Readonly<Record<DatabaseProblem, string>> = {
  "in-use": "Reload or close the other one, then try again.",
  unsupported: "Runs and scans will not be saved.",
  failed: "Runs and scans will not be saved.",
};

/** A notice at the top of the app when the database is unavailable, saying why, with a retry where one can help. Renders nothing otherwise. */
export function DatabaseNotice() {
  const { state, retry } = useDatabase();
  if (state.status !== "unavailable") return null;
  return (
    <div className={error} role="alert">
      <p>
        The stored data cannot be used because {unavailableBecause(state.problem, state.message)}.{" "}
        {CONSEQUENCES[state.problem]}
      </p>
      {state.problem !== "unsupported" && <Button onClick={retry}>Try again</Button>}
    </div>
  );
}
