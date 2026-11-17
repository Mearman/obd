import {
  MAX_ENCODED_LENGTH,
  PRACTICAL_LINK_LENGTH,
  encodeShare,
  encodeShareBundle,
  redactEnvelope,
  shareContents,
  shareLink,
  splitShareBundle,
  type EncodedShare,
  type ShareEnvelope,
  type ShareResult,
} from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, Switch } from "../ui";
import { error, list, muted, row, stack, transcript } from "../screens/screen.css";
import { KIND_NAMES } from "./saved";

/** The page's address without its fragment, which is where a link to this app starts. */
function appAddress(): string {
  return window.location.href.split("#")[0] ?? window.location.href;
}

/** What {@link ShareDialog} needs to make a link: one result to share, or several to share in one link. */
export type ShareDialogProps = {
  /** The button that opens the dialog. */
  readonly label: string;
  /** Whether the dialog is open, when something other than its own button opens it, such as a menu item; with `onOpenChange`, and then there is no button. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly title: string;
  /** The app's address the link points at; the page's own by default. */
  readonly base?: string;
} & (
  | {
      /** Builds the envelope when the dialog opens, so a run's samples are read only if the user asks to share it. */
      readonly load: () => Promise<ShareEnvelope>;
    }
  | {
      /** Builds every envelope, in the order the link carries them, when the dialog opens. One makes an ordinary link; more make a bundle link, split into shorter links when it is too long for chat apps. */
      readonly loadAll: () => Promise<readonly ShareEnvelope[]>;
    }
);

/** The redact switch's label for each kind of link that can carry identifying values; a run summary carries none. */
const REDACT_LABELS: Readonly<Record<ShareEnvelope["kind"], string | undefined>> = {
  scan: "Remove the VIN and serial numbers",
  "obd-report": "Remove the VIN and calibration identifiers",
  capture: "Overwrite the VIN, calibration identifiers and serial numbers in the raw bytes",
  "run-summary": undefined,
  plan: undefined,
  "plan-result": "Remove VIN-shaped text from the notes and freeze frames",
};

/** The switch's label for several results, when any of them carries identifying values. */
const REDACT_ALL_LABEL =
  "Remove identifying values from every result: VINs, serial numbers and calibration identifiers";

/** What is being shared: the results, and when the link is made. */
interface Shared {
  readonly envelopes: readonly ShareEnvelope[];
  readonly createdAt: number;
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly shared: Shared };

/** One of the shorter links a bundle too long for chat apps is split into, with the positions of the results it carries. */
interface Part {
  readonly link: string;
  readonly items: readonly number[];
}

type Made =
  | { readonly status: "making" }
  | { readonly status: "refused"; readonly message: string }
  | {
      readonly status: "made";
      readonly link: string;
      /** For several results whose link passes {@link PRACTICAL_LINK_LENGTH}: the shorter links that carry them. */
      readonly parts: readonly Part[];
    };

/** The outcome of making the link for one set of results and one setting of the redact switch. */
interface Attempt {
  readonly shared: Shared;
  readonly redact: boolean;
  readonly made: Made;
}

/** The link for the results: an ordinary link for one, a bundle link for several. */
function encoded(shared: Shared, redact: boolean): Promise<ShareResult<EncodedShare>> {
  const [only] = shared.envelopes;
  return shared.envelopes.length === 1 && only !== undefined
    ? encodeShare(only, streamShareCodec, { redactVin: redact })
    : encodeShareBundle(
        { createdAt: shared.createdAt, items: shared.envelopes },
        streamShareCodec,
        {
          redactVin: redact,
        },
      );
}

/** Makes the link for the results, and for several whose link is too long, the shorter links that carry them. */
async function make(shared: Shared, redact: boolean, base: string): Promise<Made> {
  const whole = await encoded(shared, redact);
  if (!whole.ok) return { status: "refused", message: whole.error.message };
  const link = shareLink(base, whole.value.fragment);
  if (shared.envelopes.length === 1 || link.length <= PRACTICAL_LINK_LENGTH) {
    return { status: "made", link, parts: [] };
  }
  const split = await splitShareBundle(
    { createdAt: shared.createdAt, items: shared.envelopes },
    streamShareCodec,
    { redactVin: redact, maxLength: PRACTICAL_LINK_LENGTH - shareLink(base, "").length },
  );
  return split.ok
    ? {
        status: "made",
        link,
        parts: split.value.map((part) => ({
          link: shareLink(base, part.fragment),
          items: part.items,
        })),
      }
    : { status: "refused", message: split.error.message };
}

/** The number of each result, from one, as a list in words: "results 1 and 2", "result 3". */
function resultNumbers(items: readonly number[]): string {
  const numbers = items.map((item) => String(item + 1));
  const last = numbers.pop();
  return numbers.length === 0
    ? `result ${last ?? ""}`
    : `results ${numbers.join(", ")} and ${last ?? ""}`;
}

function Body({
  load: given,
  base,
}: {
  readonly load: () => Promise<Shared>;
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
      (shared) => {
        if (live.active) setLoaded({ status: "ready", shared });
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

  const shared = loaded.status === "ready" ? loaded.shared : undefined;
  const several = shared !== undefined && shared.envelopes.length > 1;
  const labels =
    shared === undefined
      ? []
      : shared.envelopes.flatMap((envelope) => REDACT_LABELS[envelope.kind] ?? []);
  const redactLabel = several ? (labels.length > 0 ? REDACT_ALL_LABEL : undefined) : labels[0];
  const contents = useMemo(() => {
    if (shared === undefined) return [];
    const shown = shared.envelopes.map((envelope) =>
      redact ? redactEnvelope(envelope) : envelope,
    );
    const [only] = shown;
    return shown.length === 1 && only !== undefined
      ? shareContents(only)
      : shown.map(
          (envelope, index) =>
            `Result ${String(index + 1)} (${KIND_NAMES[envelope.kind]}): ${shareContents(envelope).join(" ")}`,
        );
  }, [shared, redact]);

  useEffect(() => {
    if (shared === undefined) return;
    const live = { active: true };
    void make(shared, redact, base).then((result) => {
      if (live.active) setAttempt({ shared, redact, made: result });
    });
    return () => {
      live.active = false;
    };
  }, [shared, redact, base]);

  const made: Made =
    attempt?.shared === shared && attempt?.redact === redact ? attempt.made : { status: "making" };
  const notice =
    spoken !== undefined &&
    made.status === "made" &&
    (spoken.link === made.link || made.parts.some((part) => part.link === spoken.link))
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
          {contents.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {redactLabel !== undefined && (
        <Switch label={redactLabel} checked={redact} onCheckedChange={setRedact} />
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
            <Badge wrap tone={made.link.length > PRACTICAL_LINK_LENGTH ? "warning" : "success"}>
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
          {made.parts.length > 0 && (
            <div className={stack}>
              <p className={muted}>
                {`Or send these ${String(made.parts.length)} links, each within ${String(PRACTICAL_LINK_LENGTH)} characters, which together carry every result:`}
              </p>
              <ol className={list} aria-label="Shorter links">
                {made.parts.map((part, index) => {
                  const name = `Link ${String(index + 1)} of ${String(made.parts.length)}`;
                  return (
                    <li key={part.link} className={stack}>
                      <span>
                        {`${name}: ${resultNumbers(part.items)}, ${String(part.link.length)} characters`}
                        {part.link.length > PRACTICAL_LINK_LENGTH &&
                          ". This result alone is over the length, so send its file instead or check the link arrives in full"}
                      </span>
                      <pre className={transcript} aria-label={name}>
                        {part.link}
                      </pre>
                      <div className={row}>
                        <Button
                          aria-label={`Copy ${name.toLowerCase()}`}
                          onClick={() => void copy(part.link)}
                        >
                          Copy
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </>
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
    </div>
  );
}

/**
 * A button that opens a dialog for sharing a result, or several in one link, as a link: it lists exactly what the link carries, offers to remove the VIN and serial numbers of a scan, generic OBD-II read or raw capture (on by default, and one choice for every result), shows the link's length against the practical limit and copies it or hands it to the system share sheet. Several results whose link passes the limit are also offered as shorter links that together carry them all.
 *
 * Nothing leaves the page: the link is made here and only the user sends it.
 */
export function ShareDialog(props: ShareDialogProps) {
  const { label, title, base, open, onOpenChange } = props;
  const several = "loadAll" in props;
  const load = (): Promise<Shared> =>
    ("loadAll" in props ? props.loadAll() : props.load().then((envelope) => [envelope])).then(
      (envelopes) => ({ envelopes, createdAt: Date.now() }),
    );
  return (
    <Dialog
      {...(open === undefined ? { trigger: <Button>{label}</Button> } : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      title={title}
      description={
        several
          ? "Make one link that carries these results, to open in the app on another device."
          : "Make a link that carries this result, to open in the app on another device."
      }
    >
      <Body load={load} base={base ?? appAddress()} />
    </Dialog>
  );
}
