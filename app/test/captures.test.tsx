import { pickProfile } from "./ui-helpers";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeShare, fragmentOfLink, simulatorUrl } from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { builtinProfileData } from "obd-read/profiles";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { createTestService, renderApp, type TestService } from "./render";

const SIMULATED_VIN = "SIMULATEDCAR00001";

const CHROME: BrowserSupport = {
  family: "chromium",
  capabilities: {
    webSerial: true,
    webBluetooth: true,
    webUsb: true,
    secureContext: true,
    usable: true,
    issues: [],
  },
};

/** Connects the service to the simulated W211 and renders the app on Scan. */
async function scanScreen(service: TestService = createTestService()): Promise<TestService> {
  await service.client.link.connect({
    profile: "mercedes-w211",
    adapter: simulatorUrl("mercedes-w211"),
  });
  renderApp(<App support={CHROME} />, service);
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await userEvent.click(screen.getByRole("tab", { name: "Scan" }));
  return service;
}

/** The text of the decoding summary once it says `pattern`. */
async function summary(pattern: RegExp): Promise<HTMLElement> {
  const found = await screen.findByRole("status", { name: "Decoding summary" });
  await waitFor(() => {
    expect(found).toHaveTextContent(pattern);
  });
  return found;
}

describe("Captures", () => {
  it("captures on Scan, opens the viewer and decodes the same capture under another profile", async () => {
    await scanScreen();
    await userEvent.click(screen.getByRole("button", { name: "Capture everything" }));
    await screen.findByRole("heading", { level: 1, name: "Library" });
    await summary(/Decoded \d+.*Left raw 0.*with mercedes-w211/);
    expect(screen.getByRole("table", { name: "Units decoded with mercedes-w211" })).toBeVisible();
    expect(screen.getByText("This profile decodes every exchange in the capture.")).toBeVisible();

    await pickProfile("", "Decode with");
    await summary(/Left raw [1-9]\d*.*Generic OBD-II/);
    const raw = screen.getByRole("table", { name: /leaves raw/ });
    expect(within(raw).getAllByText("784 -> 785").length).toBeGreaterThan(0);
    // The ESP unit's identification reply, kept raw because no profile reads it.
    expect(
      within(raw).getAllByText("785 5A8641363432313530303030302045323830434449").length,
    ).toBeGreaterThan(0);
  });

  it("shows the sweep's warning only when the sweep is switched on", async () => {
    await scanScreen();
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: /also sweep data identifiers/i }));
    expect(screen.getByRole("note")).toHaveTextContent(/thousands of requests/);
    expect(screen.getByRole("button", { name: "Capture everything" })).toHaveAccessibleDescription(
      /some log the requests/,
    );
  });

  it("re-decodes after a profile is imported in the viewer", async () => {
    const service = await scanScreen();
    await userEvent.click(screen.getByRole("switch", { name: /also sweep data identifiers/i }));
    await userEvent.clear(screen.getByRole("textbox", { name: "First identifier" }));
    await userEvent.type(screen.getByRole("textbox", { name: "First identifier" }), "0x99");
    await userEvent.clear(screen.getByRole("textbox", { name: "Last identifier" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Last identifier" }), "0x99");
    await userEvent.clear(screen.getByRole("textbox", { name: /Pause between requests/ }));
    await userEvent.type(screen.getByRole("textbox", { name: /Pause between requests/ }), "10");
    await userEvent.click(screen.getByRole("button", { name: "Capture everything" }));
    await summary(/with mercedes-w211/);
    expect(screen.queryByRole("table", { name: "Decoded values" })).toBeNull();

    const document = builtinProfileData("mercedes-w211");
    const updated: unknown = JSON.parse(JSON.stringify(document));
    if (typeof updated !== "object" || updated === null) throw new Error("no profile");
    Reflect.set(updated, "name", "w211-with-record");
    const units: unknown = Reflect.get(updated, "units");
    if (typeof units !== "object" || units === null) throw new Error("no units");
    const engine: unknown = Reflect.get(units, "engine");
    if (typeof engine !== "object" || engine === null) throw new Error("no engine");
    Reflect.set(engine, "values", {
      record: { label: "invented record", identifier: 0x99, size: 2, source: "test" },
    });
    const file = new File([JSON.stringify(updated)], "w211-with-record.json", {
      type: "application/json",
    });
    await userEvent.upload(screen.getByLabelText("Profile file to decode with"), file);
    await summary(/with w211-with-record/);
    const values = await screen.findByRole("table", { name: "Decoded values" });
    expect(within(values).getByText("invented record")).toBeVisible();
    expect(await service.client.profiles.list()).toEqual(["w211-with-record"]);
  });

  it("imports a transcript and lists what it could not recover", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText(/Nothing here yet/)).toBeVisible();
    const log = [
      "2026-01-02T03:04:05.000+00:00 > ATSP6",
      "2026-01-02T03:04:05.000+00:00 < OK",
      "2026-01-02T03:04:05.100+00:00 > 0100",
      "2026-01-02T03:04:05.150+00:00 < 7E8 06 41 00 08 18 00 00",
      "stray line",
    ].join("\n");
    await userEvent.upload(
      screen.getByLabelText("Capture, saved scan, transcript or run file"),
      new File([log], "run.log", { type: "text/plain" }),
    );
    expect(await screen.findByText("line 5: not a transcript line")).toBeVisible();
    await summary(/Decoded 1.*Left raw 0.*Generic OBD-II/);
    expect(screen.getByRole("table", { name: "Library" })).toHaveTextContent("Imported");
  });

  it("imports a file dropped anywhere on the screen and opens the viewer", async () => {
    renderApp(<App support={CHROME} />);
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText(/Nothing here yet/)).toBeVisible();
    const log = [
      "2026-01-02T03:04:05.000+00:00 > ATSP6",
      "2026-01-02T03:04:05.050+00:00 < OK",
      "2026-01-02T03:04:05.100+00:00 > 0100",
      "2026-01-02T03:04:05.150+00:00 < 7E8 06 41 00 08 18 00 00",
    ].join("\n");
    const file = new File([log], "dropped.log", { type: "text/plain" });
    fireEvent.drop(screen.getByRole("heading", { level: 1, name: "Library" }), {
      dataTransfer: { files: [file] },
    });
    await summary(/Decoded 1.*Left raw 0.*Generic OBD-II/);
    expect(screen.getByRole("table", { name: "Library" })).toHaveTextContent("Imported");
  });

  it("shares the raw capture, overwriting the VIN in its bytes unless asked to keep it", async () => {
    await scanScreen();
    await userEvent.click(screen.getByRole("button", { name: "Capture everything" }));
    await summary(/with mercedes-w211/);
    await userEvent.click(screen.getByRole("button", { name: "Share the raw capture" }));
    const dialog = await screen.findByRole("dialog", { name: "Share the raw capture" });
    const included = await within(dialog).findByRole("list", { name: "What the link contains" });
    expect(included).toHaveTextContent(/raw exchanges/);
    expect(included).toHaveTextContent("Not included: the adapter's address.");
    expect(included).toHaveTextContent(/overwritten with \*/);
    const vinBytes = Array.from(SIMULATED_VIN, (character) =>
      character.charCodeAt(0).toString(16).toUpperCase(),
    ).join("");

    const link = (await within(dialog).findByLabelText("Link")).textContent;
    const redacted = await decodeShare(fragmentOfLink(link) ?? "", streamShareCodec);
    expect(redacted).toMatchObject({
      ok: true,
      value: { kind: "capture", data: { redacted: true } },
    });
    expect(JSON.stringify(redacted)).not.toContain(vinBytes);
    expect(JSON.stringify(redacted)).not.toContain("simulator://");

    await userEvent.click(within(dialog).getByRole("switch", { name: /overwrite the vin/i }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Link").textContent).not.toBe(link);
    });
    const kept = await decodeShare(
      fragmentOfLink(within(dialog).getByLabelText("Link").textContent) ?? "",
      streamShareCodec,
    );
    expect(JSON.stringify(kept)).toContain(vinBytes);
  });
});
