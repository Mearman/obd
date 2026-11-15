import {
  CAPTURE_GZIP_SUFFIX,
  CAPTURE_JSON_SUFFIX,
  captureFileBytes,
  captureShareData,
  obdReportShareData,
  scanShareFromUnits,
  type Capture,
  type DecodedCaptureData,
  type Origin,
  type ShareEnvelope,
} from "obd-read";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { useProfiles } from "../profiles/ProfilesProvider";
import { error, muted, row, stack } from "../screens/screen.css";
import { ShareDialog } from "../share/ShareDialog";
import { Button, Card, Select, download } from "../ui";
import { OriginBadge } from "../origin/OriginBadge";
import { DecodedView } from "./DecodedView";
import { GENERIC_CHOICE, chosenProfile, useDecodeChoices } from "./decode-choices";

/** The link a decoding makes: the units under a profile, or the OBD-II report under none. Only the decoded summary travels; the raw capture has its own link. */
function decodedEnvelope(decoded: DecodedCaptureData, capture: Capture): ShareEnvelope {
  const details = {
    takenAt: capture.startedAt,
    adapterLabel: capture.sessions[0]?.adapter.identity ?? "",
  };
  if (decoded.profile === null) {
    if (decoded.obd === null) throw new Error("This capture holds no OBD-II reads to share.");
    const shared = obdReportShareData(decoded.obd, details);
    if (!shared.ok) throw new Error(shared.error.message);
    return { v: 1, kind: "obd-report", createdAt: Date.now(), data: shared.value };
  }
  const shared = scanShareFromUnits(decoded.units, { ...details, profile: decoded.profile.name });
  if (!shared.ok) throw new Error(shared.error.message);
  return { v: 1, kind: "scan", createdAt: Date.now(), data: shared.value };
}

/** The link that carries the capture's raw exchanges, for the receiver to decode with any profile. */
function captureEnvelope(capture: Capture): ShareEnvelope {
  const shared = captureShareData(capture);
  if (!shared.ok) throw new Error(shared.error.message);
  return { v: 1, kind: "capture", createdAt: Date.now(), data: shared.value };
}

/**
 * One stored capture decoded under a chosen profile, or under none. The selector lists the shipped and imported profiles and Generic; the counts and the raw table show what the chosen profile decodes and what it leaves raw. Importing a profile here re-decodes at once, and so does choosing a profile imported elsewhere.
 */
export function CaptureViewer({
  id,
  origin,
  onClose,
}: {
  readonly id: string;
  /** Where the capture came from, for its badge; undefined until the list has been read. */
  readonly origin: Origin | undefined;
  readonly onClose: () => void;
}) {
  const { service } = useDiagnostics();
  const { client } = service;
  const { imported, importText } = useProfiles();
  const options = useDecodeChoices();
  const [capture, setCapture] = useState<Capture | undefined>(undefined);
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [decoded, setDecoded] = useState<DecodedCaptureData | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [importNote, setImportNote] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const live = { active: true };
    void client.captures.get({ id }).then(
      (loaded) => {
        if (!live.active) return;
        setCapture(loaded);
        setChoice((previous) => previous ?? loaded.origin.profile ?? GENERIC_CHOICE);
      },
      (caught: unknown) => {
        if (live.active) setProblem(failureMessage(caught, "The capture could not be read."));
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, id]);

  // `imported` is a dependency so a profile imported anywhere re-decodes the capture with it.
  useEffect(() => {
    if (choice === undefined) return;
    const live = { active: true };
    void client.captures.decode({ id, profile: chosenProfile(choice) }).then(
      (result) => {
        if (!live.active) return;
        setDecoded(result);
        setProblem(undefined);
      },
      (caught: unknown) => {
        if (live.active) setProblem(failureMessage(caught, "The capture could not be decoded."));
      },
    );
    return () => {
      live.active = false;
    };
  }, [client, id, choice, imported]);

  async function onProfileFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const result = await importText(await file.text());
    if (result.ok) {
      setImportNote(`Imported ${result.name}; decoding with it.`);
      setChoice(result.name);
    } else {
      setImportNote(`That file is not a valid profile: ${result.problems.join("; ")}`);
    }
  }

  const title = capture === undefined ? "Capture" : `Capture ${capture.id}`;

  return (
    <Card title={title}>
      <div className={stack}>
        {origin !== undefined && (
          <p>
            <OriginBadge origin={origin} />
          </p>
        )}
        {capture !== undefined && (
          <p className={muted}>
            {new Date(capture.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC, from{" "}
            {capture.sessions[0]?.adapter.identity ?? "an adapter"}: {capture.origin.description}.
            {capture.origin.profile === null
              ? " Read with no profile."
              : ` Read with ${capture.origin.profile}.`}{" "}
            A capture is decoded with whichever profile you choose here.
          </p>
        )}
        <Select
          label="Decode with"
          value={choice ?? GENERIC_CHOICE}
          options={options}
          onValueChange={setChoice}
        />
        <div className={row}>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Profile file to decode with"
            onChange={(event) => void onProfileFile(event)}
          />
          <Button onClick={() => input.current?.click()}>Import a profile and re-decode</Button>
          {capture !== undefined && (
            <>
              <Button
                onClick={() => {
                  download(
                    `${capture.id}${CAPTURE_JSON_SUFFIX}`,
                    "application/json",
                    new Uint8Array(captureFileBytes(capture, false)),
                  );
                }}
              >
                Export JSON
              </Button>
              <Button
                onClick={() => {
                  download(
                    `${capture.id}${CAPTURE_GZIP_SUFFIX}`,
                    "application/gzip",
                    new Uint8Array(captureFileBytes(capture, true)),
                  );
                }}
              >
                Export compressed
              </Button>
            </>
          )}
          {capture !== undefined && (
            <ShareDialog
              label="Share the raw capture"
              title="Share the raw capture"
              load={() => Promise.resolve(captureEnvelope(capture))}
            />
          )}
          {decoded !== undefined && capture !== undefined && (
            <ShareDialog
              label="Share this decoding"
              title="Share this decoding"
              load={() => Promise.resolve(decodedEnvelope(decoded, capture))}
            />
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {importNote !== undefined && <p role="status">{importNote}</p>}
        {problem !== undefined && (
          <p role="alert" className={error}>
            {problem}
          </p>
        )}
        {decoded !== undefined && capture !== undefined && (
          <DecodedView capture={capture} decoded={decoded} />
        )}
      </div>
    </Card>
  );
}
