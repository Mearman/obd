import type { Run } from "obd-read";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Button, Card } from "../ui";
import { error, muted } from "./screen.css";

/**
 * Reads a run's CSV or TSV export back as a stored run of origin Imported, from a picked or dropped file. A file whose header is not the export's is refused with the first column that differs.
 */
export function RunImport({ onImported }: { readonly onImported: (run: Run) => void }) {
  const { service } = useDiagnostics();
  const { client } = service;
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);

  async function importFile(file: File): Promise<void> {
    setProblem(undefined);
    setNote(undefined);
    try {
      const run = await client.runs.import({ text: await file.text(), name: file.name });
      setNote(`Imported ${file.name} as a stopped run.`);
      onImported(run);
    } catch (caught) {
      setProblem(failureMessage(caught, "That file is not a run exported as CSV or TSV."));
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file !== undefined) await importFile(file);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void importFile(file);
  }

  return (
    <div
      aria-label="Import a run"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <Card
        title="Import a run"
        description="Read a run exported as CSV or TSV back in. It is kept as an imported run, read from a file and not from your adapter."
      >
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          hidden
          aria-label="Run CSV or TSV file"
          onChange={(event) => void onFile(event)}
        />
        <Button block onClick={() => input.current?.click()}>
          Import a run
        </Button>
        <p className={muted}>Or drop the file here.</p>
        {note !== undefined && <p role="status">{note}</p>}
        {problem !== undefined && (
          <p role="alert" className={error}>
            {problem}
          </p>
        )}
      </Card>
    </div>
  );
}
