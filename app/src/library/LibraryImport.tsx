import { captureText, isGzip, readCaptureFile } from "obd-read";
import { useCallback, useRef, useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { useActivity } from "../pwa/ActivityProvider";
import { error, list, muted } from "../screens/screen.css";
import { Button, Card } from "../ui";
import { importRoute } from "./import-route";
import type { LibraryKind } from "./items";

/** Reads a picked or dropped file as text, inflating a gzip capture first. */
async function fileText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGzip(bytes)) return captureText(readCaptureFile(bytes, file.name));
  return new TextDecoder().decode(bytes);
}

/** What an import left to show: a note, the lines a capture could not recover, or why it failed. */
export interface ImportOutcome {
  readonly note: string | undefined;
  readonly unrecovered: readonly string[];
  readonly problem: string | undefined;
}

const NOTHING: ImportOutcome = { note: undefined, unrecovered: [], problem: undefined };

/**
 * Imports one file into the Library, routed by its content ({@link importRoute}): a run's CSV or TSV export becomes an imported run, and a capture, saved scan or transcript an imported capture.
 *
 * @param onImported Called with the kind and id of what was kept; the Library reads its lists again and opens an imported capture.
 */
export function useLibraryImport(
  onImported: (kind: LibraryKind, id: string) => void,
): readonly [ImportOutcome, (file: File) => Promise<void>] {
  const { service } = useDiagnostics();
  const { client } = service;
  const [outcome, setOutcome] = useState<ImportOutcome>(NOTHING);
  const [importing, setImporting] = useState(false);
  // An update waits while a file is being imported, so the import is not cut off by a reload.
  useActivity("importing a file", importing);

  const routeFile = useCallback(
    async (file: File): Promise<void> => {
      let text: string;
      try {
        text = await fileText(file);
      } catch (caught) {
        setOutcome({ ...NOTHING, problem: failureMessage(caught, "That file could not be read.") });
        return;
      }
      const route = importRoute(text);
      switch (route.kind) {
        case "refused":
          setOutcome({ ...NOTHING, problem: route.reason });
          return;
        case "run":
          try {
            const run = await client.runs.import({ text, name: file.name });
            setOutcome({ ...NOTHING, note: `Imported ${file.name} as a stopped run.` });
            onImported("run", run.id);
          } catch (caught) {
            setOutcome({
              ...NOTHING,
              problem: failureMessage(caught, "That file is not a run exported as CSV or TSV."),
            });
          }
          return;
        case "capture":
          try {
            const result = await client.captures.import({ text, name: file.name });
            setOutcome({ ...NOTHING, unrecovered: result.unrecovered });
            onImported("capture", result.summary.id);
          } catch (caught) {
            setOutcome({
              ...NOTHING,
              problem: failureMessage(
                caught,
                "That file is not a capture, a saved scan or an adapter transcript.",
              ),
            });
          }
          return;
      }
    },
    [client, onImported],
  );

  const importFile = useCallback(
    async (file: File): Promise<void> => {
      setOutcome(NOTHING);
      setImporting(true);
      try {
        await routeFile(file);
      } finally {
        setImporting(false);
      }
    },
    [routeFile],
  );

  return [outcome, importFile] as const;
}

/** The Library's one import control: a button that picks a file, with what the last import left to say. Dropping a file anywhere on the Library imports it the same way; the button stays for touch and keyboard use. */
export function LibraryImport({
  outcome,
  onFile,
}: {
  readonly outcome: ImportOutcome;
  readonly onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Card
      title="Import"
      description="Read a capture, a saved scan, an adapter transcript or a run exported as CSV or TSV back in. It is kept as imported, read from a file and not from your adapter. Vehicle profiles are imported in Settings."
    >
      <input
        ref={input}
        type="file"
        accept=".json,.gz,.log,.txt,.csv,.tsv,application/json,application/gzip,text/plain,text/csv,text/tab-separated-values"
        hidden
        aria-label="Capture, saved scan, transcript or run file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) onFile(file);
        }}
      />
      <Button block onClick={() => input.current?.click()}>
        Import a file
      </Button>
      <p className={muted}>Or drop the file anywhere on this screen.</p>
      <ImportNotes outcome={outcome} />
    </Card>
  );
}

/** What the last import left to say: a note, the lines it could not recover and any problem. Shown with the Library's list and with an item the import opened. */
export function ImportNotes({ outcome }: { readonly outcome: ImportOutcome }) {
  return (
    <>
      {outcome.note !== undefined && <p role="status">{outcome.note}</p>}
      {outcome.unrecovered.length > 0 && (
        <div role="status">
          <p>Some of that file could not be turned into exchanges:</p>
          <ul className={list}>
            {outcome.unrecovered.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {outcome.problem !== undefined && (
        <p role="alert" className={error}>
          {outcome.problem}
        </p>
      )}
    </>
  );
}
