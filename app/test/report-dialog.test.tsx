import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedError } from "../src/report/capture";
import { clearSensitive, registerSensitive } from "../src/report/environment";
import { appLog } from "../src/report/events";
import { ReportDialog, REPORT_FILE_NAME } from "../src/report/ReportDialog";
import { NEW_ISSUE_URL } from "../src/report/repository";

const VIN = "WDB2110200A000000";

const ERROR: CapturedError = {
  source: "window",
  screen: "scan",
  name: "TypeError",
  message: `bad frame 7E8 10 14 49 02 01 57 44 42 for ${VIN} on OBDII Veepeak`,
  stack: "TypeError: x\n    at f (http://localhost:3000/assets/a.js:3:4)",
};

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  appLog.clear();
  registerSensitive(["OBDII Veepeak"]);
  // jsdom has no matchMedia; the report reads the display mode through it.
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ matches: false, media: query }),
    configurable: true,
  });
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
});

/** Replaces the clipboard user-event installs in `setup`, which would hide the calls under test. */
function installClipboard(): void {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  clearSensitive();
  vi.restoreAllMocks();
});

function open(error: CapturedError = ERROR, maxLinkLength?: number) {
  return render(
    <ReportDialog
      open
      onOpenChange={() => undefined}
      error={error}
      {...(maxLinkLength === undefined ? {} : { maxLinkLength })}
    />,
  );
}

describe("ReportDialog", () => {
  it("shows the exact report that will be put into the issue, scrubbed, with the public-issue notice", () => {
    appLog.record({ kind: "operation", name: "scan.run", outcome: "ok" });
    open();
    const dialog = screen.getByRole("dialog", { name: "Report this problem" });
    expect(within(dialog).getByText(/Issues in this repository are public/)).toBeVisible();
    expect(within(dialog).getByText(/The app sends nothing/)).toBeVisible();
    const text = within(dialog).getByLabelText("Report text");
    expect(text).toHaveTextContent("## Error");
    expect(text).toHaveTextContent("TypeError: bad frame 7E8 [hex] for [vin] on [redacted]");
    expect(text).toHaveTextContent("operation scan.run ok");
    expect(text.textContent).not.toContain(VIN);
    expect(text.textContent).not.toContain("Veepeak");
    expect(text.textContent).not.toContain("49 02");
    expect(text).toHaveTextContent("Browser:");
    expect(text).toHaveTextContent("Web Serial:");
    // The link carries the same body the dialog shows.
    const link = within(dialog).getByRole("link", { name: "Continue to GitHub" });
    expect(new URL(link.getAttribute("href") ?? "").searchParams.get("body")).toBe(
      text.textContent,
    );
  });

  it("continues to GitHub through a link that opens a new tab without the opener", () => {
    open();
    const link = screen.getByRole("link", { name: "Continue to GitHub" });
    const url = new URL(link.getAttribute("href") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(NEW_ISSUE_URL);
    expect(url.searchParams.get("labels")).toBe("bug");
    expect(url.searchParams.get("title")).toContain("App error on Scan: TypeError");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("copies the whole report", async () => {
    const user = userEvent.setup();
    installClipboard();
    open();
    await user.click(screen.getByRole("button", { name: "Copy report" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("App error on Scan: TypeError");
    expect(copied).toContain("## Recent events");
    expect(copied).not.toContain(VIN);
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("says so when the browser refuses to copy", async () => {
    const user = userEvent.setup();
    installClipboard();
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    open();
    await user.click(screen.getByRole("button", { name: "Copy report" }));
    expect(screen.getByRole("status")).toHaveTextContent("would not copy");
  });

  it("downloads the report as a text file", async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:test";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe(REPORT_FILE_NAME);
    });
    open();
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    expect(await blobs[0]?.text()).toContain("## Environment");
  });

  it("leaves out the oldest events when the link would be too long and says how many", () => {
    for (let index = 0; index < 150; index += 1) {
      appLog.record({
        kind: "operation",
        name: `operation.step${"abcdefghijklmnopqrstuvwxyz"[index % 26] ?? "a"}${String(Math.floor(index / 26))}`,
        outcome: "ok",
      });
    }
    open();
    expect(
      screen.getByText(/The link carries the newest events and leaves out the \d+ oldest/),
    ).toBeVisible();
  });

  it("when nothing fits in a link, continuing copies the whole report and the issue asks for a paste", async () => {
    const user = userEvent.setup();
    installClipboard();
    open(ERROR, 200);
    expect(screen.getByText(/The whole report is too long for a link/)).toBeVisible();
    const link = screen.getByRole("link", { name: "Continue to GitHub" });
    expect(new URL(link.getAttribute("href") ?? "").searchParams.get("body")).toContain(
      "Paste it here",
    );
    // Stop the click from following the link in jsdom.
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
    await user.click(link);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("## Error");
  });

  it("makes no network request of any kind", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    open();
    await user.click(screen.getByRole("button", { name: "Copy report" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
