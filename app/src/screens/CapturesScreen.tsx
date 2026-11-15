import { captureText, isGzip, readCaptureFile, type CaptureSummary } from "obd-read";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { CaptureViewer } from "../captures/CaptureViewer";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { profileTitle } from "../profiles/generic";
import { Badge, Button, Card, DataTable, type Column } from "../ui";
import { error, list, muted, page, row } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

/** Reads a picked file as text, inflating a gzip capture first. */
async function fileText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGzip(bytes)) return captureText(readCaptureFile(bytes, file.name));
  return new TextDecoder().decode(bytes);
}

/** Captures: every stored capture, import of capture files, saved scans and transcripts, and the viewer. */
export function CapturesScreen({
  open,
  onOpen,
}: {
  /** The capture the viewer shows, or undefined. */
  readonly open: string | undefined;
  readonly onOpen: (id: string | undefined) => void;
}) {
  const { service } = useDiagnostics();
  const { client } = service;
  const [captures, setCaptures] = useState<readonly CaptureSummary[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [unrecovered, setUnrecovered] = useState<readonly string[]>([]);
  const [version, setVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const live = { active: true };
    void client.captures.list({}).then((listed) => {
      if (live.active) setCaptures(listed);
    });
    return () => {
      live.active = false;
    };
  }, [client, version, open]);

  const act = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    setProblem(undefined);
    try {
      await work();
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  }, []);

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    await act(async () => {
      const result = await client.captures.import({ text: await fileText(file), name: file.name });
      setUnrecovered(result.unrecovered);
      setVersion((value) => value + 1);
      onOpen(result.summary.id);
    }, "That file is not a capture, a saved scan or an adapter transcript.");
  }

  const columns: readonly Column<CaptureSummary>[] = [
    {
      header: "Started",
      render: (capture) =>
        `${new Date(capture.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC`,
    },
    {
      header: "Read with",
      render: (capture) =>
        capture.profile === null ? "no profile" : profileTitle(capture.profile),
    },
    { header: "Exchanges", render: (capture) => String(capture.exchanges) },
    { header: "Addresses", render: (capture) => String(capture.units.length) },
    {
      header: "Kind",
      render: (capture) => (
        <span className={row}>
          <Badge>{capture.kind === "import" ? "Imported" : "Captured"}</Badge>
          {!capture.complete && <Badge tone="warning">Incomplete</Badge>}
        </span>
      ),
    },
    {
      header: "Actions",
      render: (capture) => (
        <span className={row}>
          <Button
            aria-label={`View capture ${capture.id}`}
            onClick={() => {
              onOpen(capture.id);
            }}
          >
            View
          </Button>
          <Button
            variant="ghost"
            aria-label={`Delete capture ${capture.id}`}
            onClick={() =>
              void act(async () => {
                await client.captures.delete({ id: capture.id });
                if (open === capture.id) onOpen(undefined);
                setVersion((value) => value + 1);
              }, "Could not delete the capture.")
            }
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className={page}>
      <ScreenHeading>Captures</ScreenHeading>
      <Card
        title="Raw captures"
        description="A capture keeps every raw request and reply, not what one profile made of them, so it can be decoded with any profile, a newer version of one, or none. It holds the VIN and fault history. Captures stay on this device unless you export one or share a decoding."
      >
        <input
          ref={input}
          type="file"
          accept=".json,.gz,.log,.txt,application/json,application/gzip,text/plain"
          hidden
          aria-label="Capture, saved scan or transcript file"
          onChange={(event) => void onFile(event)}
        />
        <Button block onClick={() => input.current?.click()}>
          Import a capture, saved scan or transcript
        </Button>
        {unrecovered.length > 0 && (
          <div role="status">
            <p>Some of that file could not be turned into exchanges:</p>
            <ul className={list}>
              {unrecovered.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {captures?.length === 0 && (
        <p className={muted}>No captures yet. Capture from Connect or Scan, or import a file.</p>
      )}
      {captures !== undefined && captures.length > 0 && (
        <DataTable
          label="Captures"
          columns={columns}
          rows={captures}
          rowKey={(capture) => capture.id}
        />
      )}
      {open !== undefined && (
        <CaptureViewer
          key={open}
          id={open}
          onClose={() => {
            onOpen(undefined);
          }}
        />
      )}
    </div>
  );
}
