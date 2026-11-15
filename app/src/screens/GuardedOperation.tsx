import * as RadixDialog from "@radix-ui/react-dialog";
import type { GuardedOutcomeData, GuardedRequestData } from "obd-read";
import { useState } from "react";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { Button } from "../ui";
import { actions, content, description, overlay, title } from "../ui/Dialog.css";
import { error, muted, transcript } from "./screen.css";

/** What a screen gives {@link GuardedOperation} to run one operation that changes the car. */
export interface GuardedOperationProps {
  /** The button that starts the request. */
  readonly label: string;
  /** The dialog's title. */
  readonly title: string;
  readonly disabled?: boolean;
  /** Sends the request call; nothing that changes the car is sent by it. */
  readonly request: () => Promise<GuardedRequestData>;
  /** Sends the confirming call with the id the request returned. */
  readonly confirm: (confirmation: string) => Promise<GuardedOutcomeData>;
  /** Called when the outcome dialog is closed after the operation ended, so the screen can read the car again once the user has read what happened. */
  readonly onDone?: () => void;
}

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | { readonly kind: "asking"; readonly asked: GuardedRequestData; readonly sending: boolean }
  | { readonly kind: "finished"; readonly outcome: GuardedOutcomeData };

/**
 * A button that runs an operation which changes the car in two steps, behind a dialog.
 *
 * The first click makes the request call: the service reads the car, saves a snapshot and returns what it would send. The dialog shows that, with the snapshot, and nothing is sent until "Send to the car" makes the confirming call. Cancel, Escape and a click outside answer no, which sends nothing and keeps the snapshot. The guard runs in the service; this component never holds anything that authorises a request.
 */
export function GuardedOperation({
  label,
  title: heading,
  disabled,
  request,
  confirm,
  onDone,
}: GuardedOperationProps) {
  const { service } = useDiagnostics();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [problem, setProblem] = useState<string | undefined>(undefined);

  async function ask(): Promise<void> {
    setProblem(undefined);
    setStage({ kind: "requesting" });
    try {
      setStage({ kind: "asking", asked: await request(), sending: false });
    } catch (caught) {
      setStage({ kind: "idle" });
      setProblem(failureMessage(caught, "The request failed."));
    }
  }

  async function send(asked: GuardedRequestData): Promise<void> {
    setStage({ kind: "asking", asked, sending: true });
    try {
      const outcome = await confirm(asked.confirmation);
      setStage({ kind: "finished", outcome });
    } catch (caught) {
      setStage({ kind: "idle" });
      setProblem(failureMessage(caught, "The operation failed."));
    }
  }

  async function decline(asked: GuardedRequestData): Promise<void> {
    setStage({ kind: "idle" });
    try {
      await service.client.guarded.cancel({ confirmation: asked.confirmation });
    } catch (caught) {
      setProblem(failureMessage(caught, "The request could not be cancelled."));
    }
  }

  const open = stage.kind === "asking" || stage.kind === "finished";
  return (
    <>
      <Button disabled={disabled === true || stage.kind !== "idle"} onClick={() => void ask()}>
        {stage.kind === "requesting" ? "Reading the car…" : label}
      </Button>
      {problem !== undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      <RadixDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          if (stage.kind === "asking" && !stage.sending) void decline(stage.asked);
          else if (stage.kind === "finished") {
            setStage({ kind: "idle" });
            onDone?.();
          }
        }}
      >
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={overlay} />
          <RadixDialog.Content className={content}>
            <RadixDialog.Title className={title}>{heading}</RadixDialog.Title>
            {stage.kind === "asking" && (
              <>
                <RadixDialog.Description className={description}>
                  Nothing has been sent to the car yet. This is what would be sent, and the snapshot
                  saved first.
                </RadixDialog.Description>
                <pre className={transcript}>{stage.asked.lines.join("\n")}</pre>
                <p>{stage.asked.prompt.replace(/ Type yes to continue: ?$/, "")}</p>
                {stage.asked.snapshot !== null && (
                  <p className={muted}>Snapshot: {stage.asked.snapshot.name}</p>
                )}
                <div className={actions}>
                  <Button
                    disabled={stage.sending}
                    onClick={() => {
                      void decline(stage.asked);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={stage.sending}
                    onClick={() => void send(stage.asked)}
                  >
                    {stage.sending ? "Sending…" : "Send to the car"}
                  </Button>
                </div>
              </>
            )}
            {stage.kind === "finished" && (
              <>
                <RadixDialog.Description className={description}>
                  {stage.outcome.exitStatus === 0
                    ? "Done."
                    : "Finished, but not as asked. Read the log."}
                </RadixDialog.Description>
                <pre className={transcript}>{stage.outcome.lines.join("\n")}</pre>
                <div className={actions}>
                  <RadixDialog.Close asChild>
                    <Button variant="primary">Close</Button>
                  </RadixDialog.Close>
                </div>
              </>
            )}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </>
  );
}
