import * as RadixDialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import { Button } from "../ui";
import { button } from "../ui/Button.css";
import { content, description, overlay, title as titleStyle } from "../ui/Dialog.css";
import { appLog } from "./events";
import { readEnvironment, readScrubContext } from "./environment";
import type { CapturedError } from "./capture";
import { buildIssueLink, buildReport } from "./report";
import { buttons, note, reportText } from "./report.css";

/** Props of {@link ReportDialog}. */
export interface ReportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The error the report is about. */
  readonly error: CapturedError;
  /** The longest link the dialog may make; the report module's default unless a test narrows it. */
  readonly maxLinkLength?: number;
}

/** The file name a downloaded report gets. */
export const REPORT_FILE_NAME = "obd-read-problem-report.txt";

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = REPORT_FILE_NAME;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * A dialog that shows the report exactly as it will be put into a GitHub issue, and what the user can do with it: copy it, download it, or continue to GitHub, which opens the new-issue form in another tab with the report filled in.
 *
 * The app sends nothing itself. Continuing only opens an address; the user reads the form and submits it on GitHub.
 */
export function ReportDialog({ open, onOpenChange, error, maxLinkLength }: ReportDialogProps) {
  const [status, setStatus] = useState("");
  const report = useMemo(
    () =>
      open
        ? buildReport(
            { error, events: appLog.snapshot(), environment: readEnvironment() },
            readScrubContext(),
          )
        : undefined,
    [open, error],
  );
  const link = useMemo(
    () => (report === undefined ? undefined : buildIssueLink(report, maxLinkLength)),
    [report, maxLinkLength],
  );

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied the report to the clipboard.");
      return true;
    } catch {
      setStatus("The browser would not copy it. Select the text above and copy it by hand.");
      return false;
    }
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setStatus("");
        onOpenChange(next);
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlay} />
        <RadixDialog.Content className={content}>
          <RadixDialog.Title className={titleStyle}>Report this problem</RadixDialog.Title>
          <RadixDialog.Description className={description}>
            This is the report that goes into a GitHub issue, scrubbed of VINs, serial numbers,
            addresses, file names and device names. Issues in this repository are public, so anyone
            can read it. The app sends nothing: Continue to GitHub opens the new-issue form in a new
            tab, and you submit it there.
          </RadixDialog.Description>
          {report !== undefined && link !== undefined && (
            <>
              <p className={note}>Title: {report.title}</p>
              <pre className={reportText} tabIndex={0} aria-label="Report text">
                {link.body}
              </pre>
              {link.mode === "truncated" && (
                <p className={note}>
                  The link carries the newest events and leaves out the {link.omittedEvents} oldest
                  so it fits. Copy or download keeps the whole report.
                </p>
              )}
              {link.mode === "clipboard" && (
                <p className={note}>
                  The whole report is too long for a link. Continuing copies it to the clipboard and
                  opens an issue with a short note; paste the report into it.
                </p>
              )}
              <div className={buttons}>
                <Button
                  onClick={() => {
                    void copy(report.text);
                  }}
                >
                  Copy report
                </Button>
                <Button
                  onClick={() => {
                    download(report.text);
                  }}
                >
                  Download report
                </Button>
                <a
                  className={button({ variant: "primary" })}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    if (link.mode === "clipboard") void copy(report.text);
                  }}
                >
                  Continue to GitHub
                </a>
                <RadixDialog.Close asChild>
                  <Button variant="ghost">Close</Button>
                </RadixDialog.Close>
              </div>
              <p className={note} role="status">
                {status}
              </p>
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
