import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { DatabaseInfo } from "obd-read/web/storage";
import { useActivity } from "../pwa/ActivityProvider";
import { Button, Card, download } from "../ui";
import { error, muted, stack } from "../screens/screen.css";
import { useDatabase } from "./DatabaseProvider";
import { unavailableBecause } from "./problem";

/** A name for the exported file that sorts by date, from the time it is exported. */
export function exportFileName(now: Date): string {
  return `obd-read-${now.toISOString().slice(0, 10)}.sqlite`;
}

function persistenceText(persisted: boolean | null): string {
  if (persisted === null)
    return "This browser cannot report whether the data is protected from clearing.";
  return persisted
    ? "The browser has promised not to clear this data when space runs low."
    : "The browser may clear this data when space runs low. Installing the app makes that less likely; export a copy to be safe.";
}

/** Settings card: where the data is stored, and export or import of the database as a `.sqlite` file. */
export function DatabaseCard() {
  const { state } = useDatabase();
  const [info, setInfo] = useState<DatabaseInfo | undefined>(undefined);
  const [pending, setPending] = useState<File | undefined>(undefined);
  const [message, setMessage] = useState<
    { readonly ok: boolean; readonly text: string } | undefined
  >(undefined);
  const [working, setWorking] = useState(false);
  // A chosen file waiting for confirmation counts too: a reload would drop the choice.
  useActivity("a database export or import", working || pending !== undefined);
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const ready = state.status === "ready" ? state : undefined;

  useEffect(() => {
    let current = true;
    if (ready === undefined) return;
    void ready.control.info().then((loaded) => {
      if (current) setInfo(loaded);
    });
    return () => {
      current = false;
    };
  }, [ready, message]);

  async function onExport(): Promise<void> {
    if (ready === undefined) return;
    setWorking(true);
    try {
      download(
        exportFileName(new Date()),
        "application/vnd.sqlite3",
        new Uint8Array(await ready.control.exportFile()),
      );
      setMessage({ ok: true, text: "Exported the database." });
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setWorking(false);
    }
  }

  async function onImport(): Promise<void> {
    if (ready === undefined || pending === undefined) return;
    const file = pending;
    setWorking(true);
    setPending(undefined);
    try {
      await ready.control.importFile(new Uint8Array(await file.arrayBuffer()));
      setMessage({ ok: true, text: `Replaced the stored data with ${file.name}.` });
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setWorking(false);
    }
  }

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file !== undefined) setPending(file);
  }

  return (
    <Card
      title="Stored data"
      description="Runs, samples, scans and profiles are kept in a SQLite database on this device. Nothing leaves it unless you export it."
    >
      <div className={stack}>
        {state.status === "opening" && <p className={muted}>Opening the database…</p>}
        {state.status === "unavailable" && (
          <p className={muted}>
            The database cannot be used because {unavailableBecause(state.problem, state.message)}.
          </p>
        )}
        {info !== undefined && (
          <>
            <p>
              SQLite {info.sqliteVersion} on {info.vfs}, {info.bytes.toLocaleString("en-GB")} bytes.
            </p>
            <p className={muted}>{persistenceText(info.persisted)}</p>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/x-sqlite3"
          hidden
          aria-label="Database file"
          onChange={onFile}
        />
        <Button
          block
          disabled={ready === undefined}
          onClick={() => {
            void onExport();
          }}
        >
          Export the database
        </Button>
        <Button
          block
          disabled={ready === undefined}
          onClick={() => input.current?.click()}
          aria-describedby={statusId}
        >
          Import a database file
        </Button>
        {pending !== undefined && (
          <div className={error} role="alertdialog" aria-label="Confirm import">
            <p>
              Replace everything stored on this device with {pending.name}? This cannot be undone;
              export first to keep a copy.
            </p>
            <Button
              onClick={() => {
                void onImport();
              }}
            >
              Replace the stored data
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        <div id={statusId} role="status">
          {message !== undefined &&
            (message.ok ? <p>{message.text}</p> : <p className={error}>{message.text}</p>)}
        </div>
      </div>
    </Card>
  );
}
