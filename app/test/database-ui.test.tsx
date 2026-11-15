import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DatabaseCard, exportFileName } from "../src/database/DatabaseCard";
import { DatabaseNotice } from "../src/database/DatabaseNotice";
import { fakeControl, readySession, unavailableSession } from "./fake-database";
import { renderApp } from "./render";
import { createSimulatorClient } from "../src/diagnostics/simulator";

describe("the database notice", () => {
  it("says nothing while the database is usable", async () => {
    renderApp(<DatabaseNotice />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a second tab to close the other one and retries on request", async () => {
    const restart = vi.fn(() => readySession());
    renderApp(<DatabaseNotice />, createSimulatorClient(), unavailableSession("in-use"), restart);
    expect(await screen.findByRole("alert")).toHaveTextContent(/already open in another tab/);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("explains an unsupported browser without offering a retry that cannot help", async () => {
    renderApp(<DatabaseNotice />, createSimulatorClient(), unavailableSession("unsupported"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot store data/);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("the stored data card", () => {
  it("describes the database", async () => {
    renderApp(<DatabaseCard />);
    expect(await screen.findByText(/SQLite 3\.0\.0 on fake-vfs/)).toBeVisible();
    expect(screen.getByText(/may clear this data/)).toBeVisible();
  });

  it("disables export and import while the database is unavailable", async () => {
    renderApp(<DatabaseCard />, createSimulatorClient(), unavailableSession("in-use"));
    await screen.findByText("The database is not available.");
    expect(screen.getByRole("button", { name: "Export the database" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import a database file" })).toBeDisabled();
  });

  it("asks before replacing the data, then imports the chosen file", async () => {
    const control = fakeControl();
    renderApp(<DatabaseCard />, createSimulatorClient(), readySession(control));
    await screen.findByText(/SQLite 3\.0\.0/);

    const file = new File([new Uint8Array([1, 2, 3])], "copy.sqlite");
    await userEvent.upload(screen.getByLabelText("Database file"), file);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      /Replace everything stored.*copy\.sqlite/,
    );
    expect(control.file).not.toEqual(new Uint8Array([1, 2, 3]));

    await userEvent.click(screen.getByRole("button", { name: "Replace the stored data" }));
    expect(await screen.findByText("Replaced the stored data with copy.sqlite.")).toBeVisible();
    expect(control.file).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("cancelling leaves the data alone, and a refused file shows the reason", async () => {
    const control = fakeControl();
    const before = control.file;
    renderApp(<DatabaseCard />, createSimulatorClient(), readySession(control));
    await screen.findByText(/SQLite 3\.0\.0/);

    await userEvent.upload(
      screen.getByLabelText("Database file"),
      new File([new Uint8Array([9])], "a.db"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(control.file).toBe(before);

    await userEvent.upload(screen.getByLabelText("Database file"), new File([], "empty.db"));
    await userEvent.click(screen.getByRole("button", { name: "Replace the stored data" }));
    expect(await screen.findByText("That file is not a SQLite database.")).toBeVisible();
  });
});

describe("exportFileName", () => {
  it("names the file by date", () => {
    expect(exportFileName(new Date("2026-11-15T09:00:00Z"))).toBe("obd-read-2026-11-15.sqlite");
  });
});
