import { DatabaseUnavailableError } from "obd-read/web/storage";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_LOCK } from "../src/database/exclusive";
import { HandoverError, SessionClosedError } from "../src/database/tab-share";
import { FakeOrigin, storageOf } from "./fake-tabs";

const RUN = { profile: "generic", adapter: "simulator", startedAt: 1_000 };

function samples(runId: string, from: number, count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    runId,
    signal: "engine-speed",
    unit: "rpm",
    timestamp: from + index,
    value: 800 + index,
  }));
}

describe("sharing the database between tabs", () => {
  it("lets the first tab lead and a second follow, with the second's saves in the one database", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    const firstStorage = await storageOf(first);
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);

    const run = await secondStorage.createRun(RUN);
    await secondStorage.appendSamples(samples(run.id, 1_000, 3));
    await secondStorage.stopRun(run.id, 2_000);

    expect(origin.database.openings).toEqual(["first"]);
    expect(await origin.database.base.listRuns()).toHaveLength(1);
    expect(await firstStorage.getRun(run.id)).toMatchObject({ id: run.id, stoppedAt: 2_000 });
    expect(await firstStorage.readSamples({ runId: run.id })).toHaveLength(3);
    // Every call ran on the leader's one connection.
    expect(origin.database.ran.every((call) => call.startsWith("first:"))).toBe(true);
    expect((await second.shared.connection).control).toBeDefined();
    expect(await (await second.shared.connection).control.info()).toMatchObject({
      vfs: "fake-vfs",
    });
  });

  it("tells every tab, the writer included, after a write in any tab", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    await first.shared.connection;
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);
    const firstHeard = vi.fn();
    const secondHeard = vi.fn();
    first.shared.subscribe(firstHeard);
    second.shared.subscribe(secondHeard);

    await secondStorage.saveScanReport({
      profile: "generic",
      adapter: "simulator",
      takenAt: 1,
      report: {},
    });
    await vi.waitFor(() => {
      expect(firstHeard).toHaveBeenCalledOnce();
      expect(secondHeard).toHaveBeenCalledOnce();
    });

    // A read changes nothing, so nobody is told.
    await secondStorage.listScanReports();
    await (await storageOf(first)).listRuns();
    await Promise.resolve();
    expect(firstHeard).toHaveBeenCalledOnce();
    expect(secondHeard).toHaveBeenCalledOnce();
  });

  it("hands over to a follower when the leader closes, sending a call the leader never took", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    await first.shared.connection;
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);

    // The leader goes before the call reaches it.
    const created = secondStorage.createRun(RUN);
    first.crash();

    const run = await created;
    expect(origin.locks.holder(DATABASE_LOCK)).toBe("second");
    expect(origin.database.openings).toEqual(["first", "second"]);
    expect(await origin.database.base.listRuns()).toEqual([run]);
    // The follower now leads and still reads and writes.
    await secondStorage.appendSamples(samples(run.id, 1_000, 2));
    expect(await secondStorage.readSamples({ runId: run.id })).toHaveLength(2);
  });

  it("sends a repeatable call the leader took but never answered to the next leader once", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    const run = await (await storageOf(first)).createRun(RUN);
    const second = origin.tab("second");
    const third = origin.tab("third");
    const thirdStorage = await storageOf(third);
    await second.shared.connection;

    origin.database.gate = { methods: new Set(["setRunNotes"]), place: "before" };
    const noted = thirdStorage.setRunNotes(run.id, "from the third tab");
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(1);
    });
    origin.database.gate = undefined;
    first.crash();

    expect(await noted).toMatchObject({ notes: "from the third tab" });
    // The second tab queued first, so it leads now and the third tab's call ran there.
    expect(origin.locks.holder(DATABASE_LOCK)).toBe("second");
    expect(origin.database.ran.filter((call) => call.endsWith(":setRunNotes"))).toEqual([
      "second:setRunNotes",
    ]);
  });

  it("reads back a repeated stop that the old leader had already stored", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    const run = await (await storageOf(first)).createRun(RUN);
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);

    // The old leader stops the run, then closes before it answers.
    origin.database.gate = { methods: new Set(["stopRun"]), place: "after" };
    const stopped = secondStorage.stopRun(run.id, 2_000);
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(1);
    });
    origin.database.gate = undefined;
    first.crash();

    expect(await stopped).toMatchObject({ id: run.id, stoppedAt: 2_000 });
    expect(origin.database.ran.filter((call) => call.endsWith(":stopRun"))).toEqual([
      "first:stopRun",
      "second:stopRun",
    ]);
  });

  it("fails a call that adds rows when the leader took it and closed, rather than store it twice", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    await first.shared.connection;
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);

    origin.database.gate = { methods: new Set(["createRun"]), place: "after" };
    const created = secondStorage.createRun(RUN);
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(1);
    });
    origin.database.gate = undefined;
    first.crash();

    await expect(created).rejects.toBeInstanceOf(HandoverError);
    // The old leader stored it once; the new leader did not store it again.
    expect(await origin.database.base.listRuns()).toHaveLength(1);
    expect(origin.database.ran.filter((call) => call.endsWith(":createRun"))).toEqual([
      "first:createRun",
    ]);
  });

  it("answers racing calls from several tabs, each exactly once", async () => {
    const origin = new FakeOrigin();
    const tabs = ["first", "second", "third"].map((id) => origin.tab(id));
    const storages = await Promise.all(tabs.map(storageOf));
    const created = await Promise.all(
      storages.map((storage, index) => storage.createRun({ ...RUN, startedAt: 1_000 + index })),
    );
    expect(new Set(created.map((run) => run.id)).size).toBe(3);

    const [shared] = created;
    if (shared === undefined) throw new Error("no run");
    await Promise.all(
      storages.map((storage, index) => storage.appendSamples(samples(shared.id, index * 10, 5))),
    );
    expect(await origin.database.base.listRuns()).toHaveLength(3);
    expect(await origin.database.base.readSamples({ runId: shared.id })).toHaveLength(15);
    expect(origin.database.openings).toEqual(["first"]);
  });

  it("serves a follower that arrives while the leader is in the middle of a write", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    const firstStorage = await storageOf(first);
    const run = await firstStorage.createRun(RUN);

    origin.database.gate = { methods: new Set(["appendSamples"]), place: "before" };
    const appended = firstStorage.appendSamples(samples(run.id, 1_000, 4));
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(1);
    });

    const late = origin.tab("late");
    const lateStorage = await storageOf(late);
    const lateRun = await lateStorage.createRun({ ...RUN, startedAt: 5_000 });
    const lateAppend = lateStorage.appendSamples(samples(run.id, 2_000, 2));
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(2);
    });
    origin.database.gate = undefined;
    origin.database.releaseHeld();
    await Promise.all([appended, lateAppend]);

    expect(await lateStorage.readSamples({ runId: run.id })).toHaveLength(6);
    expect(await firstStorage.getRun(lateRun.id)).toEqual(lateRun);
  });

  it("gives a follower the reason when the leader's database cannot open", async () => {
    const origin = new FakeOrigin();
    origin.database.failure = new DatabaseUnavailableError("unsupported", "no OPFS here");
    const first = origin.tab("first");
    await expect(first.shared.connection).rejects.toMatchObject({ reason: "unsupported" });
    const second = origin.tab("second");
    await expect(second.shared.connection).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(second.shared.connection).rejects.toMatchObject({
      reason: "unsupported",
      message: "no OPFS here",
    });
  });

  it("reports in-use when the tab holding the lock never answers", async () => {
    const origin = new FakeOrigin(20);
    origin.locks.hold("older-version", DATABASE_LOCK);
    const tab = origin.tab("tab");
    await expect(tab.shared.connection).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(tab.shared.connection).rejects.toMatchObject({ reason: "in-use" });
  });

  it("rejects the calls waiting in a closed session", async () => {
    const origin = new FakeOrigin();
    const first = origin.tab("first");
    await first.shared.connection;
    const second = origin.tab("second");
    const secondStorage = await storageOf(second);
    origin.database.gate = { methods: new Set(["listRuns"]), place: "before" };
    const listed = secondStorage.listRuns();
    await vi.waitFor(() => {
      expect(origin.database.waiting).toBe(1);
    });
    second.shared.close();
    await expect(listed).rejects.toBeInstanceOf(SessionClosedError);
  });

  describe("busy, which an update waits for", () => {
    it("holds while a follower's write runs on the leader, in both tabs, and clears once it answers", async () => {
      const origin = new FakeOrigin();
      const first = origin.tab("first");
      await storageOf(first);
      const second = origin.tab("second");
      const secondStorage = await storageOf(second);
      await vi.waitFor(() => {
        expect(first.shared.busy() || second.shared.busy()).toBe(false);
      });

      origin.database.gate = { methods: new Set(["createRun"]), place: "before" };
      const created = secondStorage.createRun(RUN);
      await vi.waitFor(() => {
        expect(origin.database.waiting).toBe(1);
      });
      expect(second.shared.busy()).toBe(true);
      // The leader serves the call: a reload of the leader now would leave the follower not knowing whether it was saved.
      expect(first.shared.busy()).toBe(true);

      origin.database.gate = undefined;
      origin.database.releaseHeld();
      await created;
      await vi.waitFor(() => {
        expect(first.shared.busy()).toBe(false);
        expect(second.shared.busy()).toBe(false);
      });
    });

    it("tells its listeners when it changes", async () => {
      const origin = new FakeOrigin();
      const tab = origin.tab("tab");
      const storage = await storageOf(tab);
      const changes: boolean[] = [];
      tab.shared.subscribeBusy(() => changes.push(tab.shared.busy()));
      await storage.listRuns();
      expect(changes).toContain(true);
      expect(changes.at(-1)).toBe(false);
    });

    it("is not busy while waiting for a tab that cannot share, so such a tab can still update", async () => {
      const origin = new FakeOrigin(20);
      origin.locks.hold("older-version", DATABASE_LOCK);
      const tab = origin.tab("tab");
      await expect(tab.shared.connection).rejects.toMatchObject({ reason: "in-use" });
      expect(tab.shared.busy()).toBe(false);
    });
  });
});
