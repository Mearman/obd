import {
  decodeCapture,
  decodedCaptureData,
  parseProfile,
  type CaptureShareData,
  type DecodeTarget,
  type DecodedCaptureData,
  type Storage,
} from "obd-read";
import { builtinProfiles, loadBuiltinProfile } from "obd-read/profiles";
import { useEffect, useState } from "react";
import { DecodedView } from "../captures/DecodedView";
import { GENERIC_CHOICE, chosenProfile, useDecodeChoices } from "../captures/decode-choices";
import { error, muted, stack } from "../screens/screen.css";
import { Card, Select } from "../ui";

/** The decode target for a choice: a shipped profile from the bundle, an imported one read from storage, or none. */
async function targetFor(choice: string, storage: Storage | undefined): Promise<DecodeTarget> {
  const name = chosenProfile(choice);
  if (name === null) return { kind: "generic" };
  if (builtinProfiles().includes(name)) {
    return { kind: "profile", profile: loadBuiltinProfile(name) };
  }
  if (storage === undefined) {
    throw new Error(`The imported profile ${name} cannot be read until the database is open.`);
  }
  const stored = await storage.getProfile(name);
  if (stored === undefined) throw new Error(`There is no imported profile ${name}.`);
  return { kind: "profile", profile: parseProfile(stored.document, name) };
}

/** The choice a shared capture opens with: the profile it was read with when this app has it, else Generic. The link only picks among profiles already here. */
function initialChoice(data: CaptureShareData, choices: readonly string[]): string {
  const named = data.capture.origin.profile;
  return named !== null && choices.includes(named) ? named : GENERIC_CHOICE;
}

/** Decoding state of one choice. */
type Decoding =
  | { readonly choice: string; readonly status: "ready"; readonly decoded: DecodedCaptureData }
  | { readonly choice: string; readonly status: "failed"; readonly message: string };

/**
 * A shared capture, read-only, decoded in the page with the profile chosen in its selector (shipped, imported or Generic), live on every change: the counts, the decoded tables and every exchange marked decoded or left raw show what that profile makes of the raw bytes. Decoding reads the capture and the profile only; the database is read for an imported profile and never written here.
 */
export function SharedCaptureView({
  data,
  storage,
}: {
  readonly data: CaptureShareData;
  /** The database, for reading imported profiles; undefined while it is not open. */
  readonly storage: Storage | undefined;
}) {
  const { capture } = data;
  const options = useDecodeChoices();
  const [choice, setChoice] = useState(() =>
    initialChoice(
      data,
      options.map((option) => option.value),
    ),
  );
  const [decoding, setDecoding] = useState<Decoding | undefined>(undefined);

  useEffect(() => {
    const live = { active: true };
    void (async () => {
      try {
        const decoded = decodedCaptureData(
          await decodeCapture(capture, await targetFor(choice, storage)),
        );
        if (live.active) setDecoding({ choice, status: "ready", decoded });
      } catch (caught) {
        if (live.active) {
          setDecoding({
            choice,
            status: "failed",
            message: caught instanceof Error ? caught.message : "The capture could not be decoded.",
          });
        }
      }
    })();
    return () => {
      live.active = false;
    };
  }, [capture, choice, storage]);

  const current = decoding?.choice === choice ? decoding : undefined;
  return (
    <Card
      title="The capture"
      description={`Raw exchanges captured ${new Date(capture.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC from ${capture.sessions[0]?.adapter.identity ?? "an adapter"}: ${capture.origin.description}${capture.origin.complete ? "" : " (stopped before it finished)"}. ${capture.origin.profile === null ? "Read with no profile." : `Read with ${capture.origin.profile}.`} ${data.redacted ? "The sender overwrote the VIN, calibration identifiers and serial numbers with *." : "The VIN, calibration identifiers and serial numbers are included."}`}
    >
      <div className={stack}>
        <p className={muted}>
          The link carries the raw requests and replies, not what any profile made of them. Choose a
          profile here to decode them; nothing is saved by choosing.
        </p>
        <Select label="Decode with" value={choice} options={options} onValueChange={setChoice} />
        {current === undefined && <p className={muted}>Decoding…</p>}
        {current?.status === "failed" && (
          <p role="alert" className={error}>
            {current.message}
          </p>
        )}
        {current?.status === "ready" && <DecodedView capture={capture} decoded={current.decoded} />}
      </div>
    </Card>
  );
}
