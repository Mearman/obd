import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseNotice } from "../src/database/DatabaseNotice";
import { createActivityRegistry, followActivity } from "../src/pwa/activity";
import { DatabaseCatchUp } from "../src/pwa/DatabaseCatchUp";
import { CHECK_INTERVAL_MS, readVersionMessage } from "../src/pwa/updater";
import { UpdateCard } from "../src/pwa/UpdateCard";
import { compareVersions } from "../src/pwa/version-order";
import { APP_VERSION } from "../src/release/release";
import { readySession, unavailableSession } from "./fake-database";
import { FakeBroadcast, fakeMemory, openFakeTab } from "./fake-updates";
import { renderApp } from "./render";

/** Lets queued microtasks (channel deliveries, the update promise) run. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("compareVersions", () => {
  it("orders by semantic versioning precedence, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.2", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3-beta.10", "1.2.3-beta.9")).toBe(1);
    expect(compareVersions("1.2.3-beta", "1.2.3-beta.1")).toBe(-1);
    expect(compareVersions("1.2.3-1", "1.2.3-alpha")).toBe(-1);
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
  });

  it("refuses anything that is not a semantic version", () => {
    expect(compareVersions("latest", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0", "1.0.0")).toBeUndefined();
  });
});

describe("readVersionMessage", () => {
  it("reads a version message and nothing else", () => {
    expect(readVersionMessage({ kind: "version", version: "1.0.0", ask: true })).toEqual({
      kind: "version",
      version: "1.0.0",
      ask: true,
    });
    expect(readVersionMessage({ kind: "version", version: 1, ask: true })).toBeUndefined();
    expect(readVersionMessage({ kind: "leader", leader: "a" })).toBeUndefined();
    expect(readVersionMessage(null)).toBeUndefined();
  });
});

describe("the activity registry", () => {
  it("is busy while any activity runs and ends each once", () => {
    const registry = createActivityRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const endScan = registry.begin("a scan");
    const endSave = registry.begin("a save");
    expect(registry.running()).toEqual(["a scan", "a save"]);
    endScan();
    endScan();
    expect(registry.running()).toEqual(["a save"]);
    endSave();
    expect(registry.running()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("follows a source that reports itself busy", () => {
    const registry = createActivityRegistry();
    let busy = false;
    const listeners = new Set<() => void>();
    const stop = followActivity(registry, "stored data", {
      busy: () => busy,
      subscribeBusy: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const change = (next: boolean): void => {
      busy = next;
      for (const listener of listeners) listener();
    };
    change(true);
    change(true);
    expect(registry.running()).toEqual(["stored data"]);
    change(false);
    expect(registry.running()).toEqual([]);
    change(true);
    stop();
    expect(registry.running()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

describe("the updater", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks when attached and then every interval", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    expect(tab.worker.update).toHaveBeenCalledTimes(1);
    expect(tab.updater.status().lastChecked).toBe(Date.now());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    });
    expect(tab.worker.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(tab.worker.update).toHaveBeenCalledTimes(2);
    tab.updater.dispose();
  });

  it("checks when the tab becomes visible and when the browser comes back online", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    tab.page.visible();
    await settle();
    expect(tab.worker.update).toHaveBeenCalledTimes(2);
    tab.page.comeOnline();
    await settle();
    expect(tab.worker.update).toHaveBeenCalledTimes(3);
  });

  it("does not check offline, and says so", async () => {
    const tab = openFakeTab("1.0.0", new FakeBroadcast(), false);
    tab.page.isOnline = false;
    tab.updater.attach(tab.worker);
    await settle();
    expect(tab.worker.update).not.toHaveBeenCalled();
    expect(tab.updater.status().problem).toBe("The browser is offline.");
  });

  it("reports a failed check without moving the last checked time", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    const checked = tab.updater.status().lastChecked;
    vi.advanceTimersByTime(1000);
    tab.worker.update.mockRejectedValueOnce(new TypeError("Failed to update a ServiceWorker"));
    await tab.updater.checkNow();
    expect(tab.updater.status().problem).toBe("Failed to update a ServiceWorker");
    expect(tab.updater.status().lastChecked).toBe(checked);
  });

  it("applies a waiting update at once when the tab is idle", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    tab.worker.deploy();
    await tab.updater.checkNow();
    expect(tab.worker.activate).toHaveBeenCalledTimes(1);
    expect(tab.page.reloads()).toBe(1);
  });

  it("defers while busy and applies as soon as the activity ends", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    const end = tab.activity.begin("a collection run");
    tab.worker.deploy();
    await tab.updater.checkNow();
    expect(tab.worker.activate).not.toHaveBeenCalled();
    expect(tab.updater.status()).toMatchObject({
      ready: true,
      prompt: true,
      waitingFor: ["a collection run"],
    });
    end();
    expect(tab.worker.activate).toHaveBeenCalledTimes(1);
    expect(tab.page.reloads()).toBe(1);
  });

  it("still applies on its own after the prompt was dismissed", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    const end = tab.activity.begin("a scan");
    tab.updater.waiting();
    tab.updater.dismiss();
    expect(tab.updater.status()).toMatchObject({ ready: true, prompt: false });
    expect(tab.page.reloads()).toBe(0);
    end();
    expect(tab.page.reloads()).toBe(1);
  });

  it("applies at once when the person presses Reload, whatever runs", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    tab.activity.begin("a scan");
    tab.updater.waiting();
    expect(tab.page.reloads()).toBe(0);
    tab.updater.applyNow();
    expect(tab.page.reloads()).toBe(1);
  });

  it("does not reload a busy tab that another tab's update took over, until it is idle", async () => {
    const tab = openFakeTab("1.0.0");
    await settle();
    const end = tab.activity.begin("saving a shared link");
    tab.page.controllerChange();
    expect(tab.page.reloads()).toBe(0);
    expect(tab.updater.status().ready).toBe(true);
    end();
    expect(tab.page.reloads()).toBe(1);
  });

  describe("between tabs", () => {
    it("an idle older tab updates itself when a newer tab starts", async () => {
      const broadcast = new FakeBroadcast();
      const older = openFakeTab("1.0.0", broadcast);
      await settle();
      older.worker.deploy();
      openFakeTab("1.1.0", broadcast);
      await settle();
      expect(older.worker.update).toHaveBeenCalledTimes(2);
      expect(older.worker.activate).toHaveBeenCalledTimes(1);
      expect(older.page.reloads()).toBe(1);
    });

    it("a busy older tab waits, and a newer tab is never told to go back", async () => {
      const broadcast = new FakeBroadcast();
      const older = openFakeTab("1.0.0", broadcast);
      await settle();
      const end = older.activity.begin("a collection run");
      older.worker.deploy();
      const newer = openFakeTab("1.1.0", broadcast);
      await settle();
      expect(older.page.reloads()).toBe(0);
      expect(older.updater.status().prompt).toBe(true);
      expect(newer.updater.status().ready).toBe(false);
      expect(newer.page.reloads()).toBe(0);
      end();
      expect(older.page.reloads()).toBe(1);
    });

    it("a newer tab answers an older one that starts later", async () => {
      const broadcast = new FakeBroadcast();
      const newer = openFakeTab("1.1.0", broadcast);
      await settle();
      const older = openFakeTab("1.0.0", broadcast);
      older.worker.deploy();
      await settle();
      expect(newer.channel.sent).toContainEqual({ kind: "version", version: "1.1.0", ask: false });
      expect(older.page.reloads()).toBe(1);
    });

    it("an older tab with no worker waiting reloads once for the newer version, never in a loop", async () => {
      const broadcast = new FakeBroadcast();
      const older = openFakeTab("1.0.0", broadcast);
      await settle();
      openFakeTab("1.1.0", broadcast);
      await settle();
      expect(older.worker.activate).not.toHaveBeenCalled();
      expect(older.page.reloads()).toBe(1);

      // The reload came back on the old version: with the same memory it must not reload for 1.1.0 again.
      const memory = fakeMemory();
      memory.write("1.1.0");
      const reloaded = openFakeTab("1.0.0", broadcast, true, memory);
      await settle();
      expect(reloaded.page.reloads()).toBe(0);
      expect(reloaded.updater.status()).toMatchObject({ ready: true, prompt: true });
    });

    it("tabs on the same version leave each other alone", async () => {
      const broadcast = new FakeBroadcast();
      const first = openFakeTab("1.0.0", broadcast);
      openFakeTab("1.0.0", broadcast);
      await settle();
      expect(first.page.reloads()).toBe(0);
      expect(first.updater.status().ready).toBe(false);
    });
  });
});

describe("the Settings card", () => {
  it("shows the running version and checks on demand", async () => {
    const user = userEvent.setup();
    const tab = openFakeTab(APP_VERSION);
    await renderApp(<UpdateCard />, undefined, undefined, undefined, tab);
    expect(screen.getByText(`Running version ${APP_VERSION}.`)).toBeInTheDocument();
    expect(await screen.findByText(/^Last checked for a new version on /)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(tab.worker.update).toHaveBeenCalledTimes(2);
  });

  it("says what a ready update waits for", async () => {
    const tab = openFakeTab(APP_VERSION);
    tab.activity.begin("a collection run");
    await renderApp(<UpdateCard />, undefined, undefined, undefined, tab);
    act(() => {
      tab.updater.waiting();
    });
    expect(
      await screen.findByText(
        "A new version is ready. It loads by itself once these finish: a collection run.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload onto the new version" })).toBeVisible();
  });
});

describe("catching up on the database", () => {
  it("opens the database again once a tab on this version appears, after an older one held it", async () => {
    const broadcast = new FakeBroadcast();
    const tab = openFakeTab(APP_VERSION, broadcast);
    await renderApp(
      <>
        <DatabaseCatchUp />
        <DatabaseNotice />
      </>,
      undefined,
      unavailableSession("in-use"),
      readySession,
      tab,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot share");
    // An unrelated version does not count: only a tab that now runs this version took over.
    openFakeTab("0.0.1", broadcast, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    openFakeTab(APP_VERSION, broadcast, false);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
