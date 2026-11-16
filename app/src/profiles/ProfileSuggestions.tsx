import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Button, Card } from "../ui";
import { error, list, muted } from "../screens/screen.css";
import { useProfileSuggestions } from "./vin-suggestions";

/**
 * After a generic OBD-II read reports a VIN, the profiles that VIN suggests, each with a button that disconnects and selects it for the next connection. Nothing changes until the person presses one: the app never switches profile on its own. Shows nothing on a profile connection, before a read reports a VIN or when no profile matches.
 */
export function ProfileSuggestions() {
  const { connection, readVin, disconnect, setProfile } = useDiagnostics();
  const suggestions = useProfileSuggestions(connection?.profile === null ? readVin : undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (connection?.profile !== null || suggestions.length === 0) return null;

  async function use(name: string): Promise<void> {
    setProblem(undefined);
    try {
      await disconnect();
      setProfile(name);
    } catch (caught) {
      setProblem(failureMessage(caught, "Disconnecting failed."));
    }
  }

  return (
    <Card
      title="Profiles for this VIN"
      description="The VIN this read reported matches these profiles. A profile reaches the car's own control units, beyond the legislated reads. Choosing one disconnects and selects it; then connect again to read the car with it."
    >
      <ul className={list} aria-label="Profiles for this VIN">
        {suggestions.map(({ profile, match }) => (
          <li key={profile.name}>
            <p>
              <strong>{profile.name}</strong>: {profile.description}.{" "}
              <span className={muted}>
                {match === "model"
                  ? "The maker and the model in the VIN match."
                  : "Only the maker in the VIN matches; this profile names no models."}
              </span>
            </p>
            <Button variant="secondary" onClick={() => void use(profile.name)}>
              {`Use ${profile.name}`}
            </Button>
          </li>
        ))}
      </ul>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
    </Card>
  );
}
