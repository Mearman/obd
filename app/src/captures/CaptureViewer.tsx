import {
  CAPTURE_GZIP_SUFFIX,
  CAPTURE_JSON_SUFFIX,
  captureFileBytes,
  captureShareData,
  obdReportShareData,
  scanShareFromUnits,
  type Capture,
  type DecodedCaptureData,
  type ShareEnvelope,
} from "obd-read";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { GENERIC_TITLE } from "../profiles/generic";
import { useProfiles } from "../profiles/ProfilesProvider";
import { ObdReport } from "../screens/ObdReport";
import { FaultCodesTable, ScanResultsTable } from "../screens/ScanResults";
import { error, list, muted, row, stack, transcript } from "../screens/screen.css";
import { ShareDialog } from "../share/ShareDialog";
import { RAW_COLUMNS } from "./exchange-columns";
import { Badge, Button, Card, DataTable, Select, download } from "../ui";

/** The selector's value for decoding with no profile. */
const GENERIC_CHOICE = "";

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
  onClose,
}: {
  readonly id: string;
  readonly onClose: () => void;
}) {
  const { service } = useDiagnostics();
  const { client } = service;
  const { builtin, imported, importText } = useProfiles();
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
    void client.captures.decode({ id, profile: choice === GENERIC_CHOICE ? null : choice }).then(
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

  const options = useMemo(
    () => [
      { value: GENERIC_CHOICE, label: GENERIC_TITLE },
      ...builtin.map((name) => ({ value: name, label: name })),
      ...imported
        .filter((name) => !builtin.includes(name))
        .map((name) => ({ value: name, label: `${name} (imported)` })),
    ],
    [builtin, imported],
  );

  const raw = useMemo(() => {
    if (capture === undefined || decoded === undefined) return [];
    const left = new Set(decoded.undecoded);
    return capture.exchanges.filter((exchange) => left.has(exchange.seq));
  }, [capture, decoded]);

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

  const decodedCount = decoded === undefined ? 0 : decoded.exchanges - decoded.undecoded.length;
  const title = capture === undefined ? "Capture" : `Capture ${capture.id}`;

  return (
    <Card title={title}>
      <div className={stack}>
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
        {decoded !== undefined && (
          <>
            <p role="status" aria-label="Decoding summary">
              <Badge tone="success">Decoded {String(decodedCount)}</Badge>{" "}
              <Badge tone={raw.length > 0 ? "warning" : "neutral"}>
                Left raw {String(raw.length)}
              </Badge>{" "}
              of {String(decoded.exchanges)} exchanges with{" "}
              {decoded.profile === null ? GENERIC_TITLE : decoded.profile.name}.
            </p>
            {decoded.units.length > 0 && (
              <>
                <ScanResultsTable
                  label={`Units decoded with ${decoded.profile?.name ?? GENERIC_TITLE}`}
                  units={decoded.units}
                />
                <FaultCodesTable label="Decoded fault codes" units={decoded.units} />
              </>
            )}
            {decoded.values.length > 0 && (
              <DataTable
                label="Decoded values"
                columns={[
                  { header: "Unit", render: (value) => value.unit },
                  { header: "Value", render: (value) => value.label },
                  {
                    header: "Reading",
                    render: (value) =>
                      typeof value.value === "number"
                        ? `${String(value.value)} ${value.measure}`.trim()
                        : `not decoded (${value.value.error})`,
                  },
                ]}
                rows={decoded.values}
                rowKey={(value) => `${value.unit}-${value.name}`}
              />
            )}
            {decoded.discovered.length > 0 && (
              <ul className={list} aria-label="Units a sweep found">
                {decoded.discovered.map((found) => (
                  <li key={`${String(found.requestId)}-${String(found.responseId)}`}>
                    {found.requestId.toString(16).toUpperCase()} answered from{" "}
                    {found.responseId.toString(16).toUpperCase()}: {found.detail}
                  </li>
                ))}
              </ul>
            )}
            {decoded.obd !== null && <ObdReport scan={decoded.obd} />}
            {raw.length > 0 ? (
              <DataTable
                label={`Exchanges ${decoded.profile?.name ?? GENERIC_TITLE} leaves raw`}
                columns={RAW_COLUMNS}
                rows={raw}
                rowKey={(exchange) => String(exchange.seq)}
              />
            ) : (
              <p className={muted}>This profile decodes every exchange in the capture.</p>
            )}
            <details>
              <summary>The decoding as text</summary>
              <pre className={transcript}>{decoded.lines.join("\n")}</pre>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}
