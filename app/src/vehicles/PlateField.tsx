import { formatPlate, normalisePlate } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { error, muted, row } from "../screens/screen.css";
import { Button, TextField } from "../ui";

/**
 * The optional number plate of the connected car: typed by the person, kept for this connection only, and recorded with every run, capture and report saved on it. Nothing is looked up from it.
 */
export function PlateField() {
  const { connection, setPlate } = useDiagnostics();
  const saved = connection?.plate ?? null;
  const [text, setText] = useState(saved === null ? "" : formatPlate(saved));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const typed = normalisePlate(text);

  async function save(plate: string | null): Promise<void> {
    setProblem(undefined);
    try {
      await setPlate(plate);
      setText(plate === null ? "" : formatPlate(plate));
    } catch (caught) {
      setProblem(failureMessage(caught, "The plate could not be kept."));
    }
  }

  return (
    <>
      <div className={row}>
        <TextField label="Number plate (optional)" value={text} onValueChange={setText} />
        <Button disabled={typed === saved} onClick={() => void save(typed)}>
          {typed === null && saved !== null ? "Remove plate" : "Keep plate"}
        </Button>
      </div>
      <p className={muted}>
        {saved === null
          ? "Kept with what you save on this connection, so the Library can tell cars apart. It stays on this device and is never looked up."
          : `${formatPlate(saved)} is kept with what you save on this connection. It stays on this device and is never looked up.`}
      </p>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
    </>
  );
}
