import {
  MAX_ENCODED_LENGTH,
  PRACTICAL_LINK_LENGTH,
  encodeShare,
  redactEnvelope,
  shareContents,
  shareLink,
  type ShareEnvelope,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, Switch } from "../ui";
import { error, list, muted, row, stack, transcript } from "../screens/screen.css";

/** The page's address without its fragment, which is where a link to this app starts. */
function appAddress(): string {
  return window.location.href.split("#")[0] ?? window.location.href;
}

/** What {@link ShareDialog} needs to make a link. */
export interface ShareDialogProps {
  /** The button that opens the dialog. */
  readonly label: string;
  readonly title: string;
  /** Builds the envelope when the dialog opens, so a run's samples are read only if the user asks to share it. */
  readonly load: () => Promise<ShareEnvelope>;
  /** The app's address the link points at; the page's own by default. */
  readonly base?: string;
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly envelope: ShareEnvelope };

type Made =
  | { readonly status: "making" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "made"; readonly link: string };

/** The outcome of making the link for one envelope and one setting of the redact switch. */
interface Attempt {
  readonly envelope: ShareEnvelope;
  readonly redact: boolean;
  readonly made: Made;
}

function Body({
  load: given,
  base,
}: {
  readonly load: () => Promise<ShareEnvelope>;
  readonly base: string;
}) {
  // The dialog reads its data once, when it opens; a parent re-rendering with a new function must not read it again.
  const [load] = useState(() => given);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [redact, setRedact] = useState(true);
  const [attempt, setAttempt] = useState<Attempt | undefined>(undefined);
  const [spoken, setSpoken] = useState<
    { readonly link: string; readonly text: string } | undefined
  >(undefined);

  useEffect(() => {
    const live = { active: true };
    load().then(
      (envelope) => {
        if (live.active) setLoaded({ status: "ready", envelope });
      },
      (caught: unknown) => {
        if (live.active) {
          setLoaded({
            status: "failed",
            message: caught instanceof Error ? caught.message : "The data could not be read.",
          });
        }
      },
    );
    return () => {
      live.active = false;
    };
  }, [load]);

  const envelope = loaded.status === "ready" ? loaded.envelope : undefined;
  const hasIdentity = envelope?.kind === "scan" || envelope?.kind === "obd-report";
  const shown = useMemo(() => {
    if (envelope === undefined) return undefined;
    return redact ? redactEnvelope(envelope) : envelope;
  }, [envelope, redact]);

  useEffect(() => {
    if (envelope === undefined) return;
    const live = { active: true };
    void encodeShare(envelope, streamShareCodec, { redactVin: redact }).then((result) => {
      if (!live.active) return;
      setAttempt({
        envelope,
        redact,
        made: result.ok
          ? { status: "made", link: shareLink(base, result.value.fragment) }
          : { status: "refused", message: result.error.message },
      });
    });
    return () => {
      live.active = false;
    };
  }, [envelope, redact, base]);

  const made: Made =
    attempt?.envelope === envelope && attempt?.redact === redact
      ? attempt.made
      : { status: "making" };
  const notice =
    spoken !== undefined && made.status === "made" && spoken.link === made.link
      ? spoken.text
      : undefined;

  if (loaded.status === "loading") return <p className={muted}>Reading the data to share…</p>;
  if (loaded.status === "failed") {
    return (
      <p role="alert" className={error}>
        {loaded.message}
      </p>
    );
  }

  async function copy(link: string): Promise<void> {
    const say = (text: string): void => {
      setSpoken({ link, text });
    };
    try {
      await navigator.clipboard.writeText(link);
      say("Link copied.");
    } catch {
      say("The browser would not copy it. Select the link above and copy it by hand.");
    }
  }

  async function send(link: string): Promise<void> {
    try {
      await navigator.share({ title: "obd-read result", url: link });
    } catch (caught) {
      // Closing the system share sheet rejects with AbortError, which is not a failure.
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setSpoken({ link, text: "The share sheet could not open. Copy the link instead." });
      }
    }
  }

  return (
    <div className={stack}>
      <div>
        <strong>The link contains:</strong>
        <ul className={list} aria-label="What the link contains">
          {shown !== undefined && shareContents(shown).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {hasIdentity && (
        <Switch
          label="Remove the VIN and serial numbers"
          checked={redact}
          onCheckedChange={setRedact}
        />
      )}
      <p className={muted}>
        The data sits after the # in the link, which a browser never sends to a server. Anyone who
        has the link can read it, so share it only where you would share the fault history.
      </p>
      {made.status === "making" && <p className={muted}>Making the link…</p>}
      {made.status === "refused" && (
        <p role="alert" className={error}>
          {made.message}
        </p>
      )}
      {made.status === "made" && (
        <>
          <pre className={transcript} aria-label="Link">
            {made.link}
          </pre>
          <p>
            <Badge tone={made.link.length > PRACTICAL_LINK_LENGTH ? "warning" : "success"}>
              {`${String(made.link.length)} characters`}
            </Badge>{" "}
            <span className={muted}>
              {made.link.length > PRACTICAL_LINK_LENGTH
                ? `Over ${String(PRACTICAL_LINK_LENGTH)}: some chat apps and mail clients cut a link this long. This app reads links up to ${String(MAX_ENCODED_LENGTH)}.`
                : `Within ${String(PRACTICAL_LINK_LENGTH)}, which every browser and messenger keeps whole.`}
            </span>
          </p>
          <div className={row}>
            <Button variant="primary" onClick={() => void copy(made.link)}>
              Copy link
            </Button>
            {"share" in navigator && <Button onClick={() => void send(made.link)}>Share…</Button>}
          </div>
        </>
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
    </div>
  );
}

/**
 * A button that opens a dialog for sharing a result as a link: it lists exactly what the link carries, offers to remove the VIN and serial numbers of a scan or generic OBD-II read (on by default), shows the link's length against the practical limit and copies it or hands it to the system share sheet.
 *
 * Nothing leaves the page: the link is made here and only the user sends it.
 */
export function ShareDialog({ label, title, load, base }: ShareDialogProps) {
  return (
    <Dialog
      trigger={<Button>{label}</Button>}
      title={title}
      description="Make a link that carries this result, to open in the app on another device."
    >
      <Body load={load} base={base ?? appAddress()} />
    </Dialog>
  );
}
