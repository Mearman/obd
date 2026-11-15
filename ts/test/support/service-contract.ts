import { describe, expect, it } from "vitest";
import {
  SCHEMES,
  registerTransport,
  registeredSchemes,
  type DiagnosticsClient,
  type Sample,
} from "../../src/core/index.js";
import { builtinProfileData } from "../../src/profiles/index.js";
import { newHost, type FakeCollector } from "./service-fixtures.js";

/** What a service test gets: the client under test and the pieces behind it. */
export interface ServiceFixture {
  readonly client: DiagnosticsClient;
  readonly collector: FakeCollector;
  readonly clock: { time: number };
  readonly dispose: () => void;
}

/**
 * The behaviour of the diagnostics service as a client sees it, run the same way in process and over a message port. `connect` builds a client over a fresh host.
 */
export function describeServiceContract(
  name: string,
  connect: (host: ReturnType<typeof newHost>) => { client: DiagnosticsClient; dispose: () => void },
): void {
  describe(`${name} diagnostics service`, () => {
    function fixture(): ServiceFixture {
      const parts = newHost();
      const { client, dispose } = connect(parts);
      return { client, collector: parts.collector, clock: parts.clock, dispose };
    }

    async function withService(body: (service: ServiceFixture) => Promise<void>): Promise<void> {
      const service = fixture();
      try {
        await body(service);
      } finally {
        service.dispose();
      }
    }

    it("lists every adapter scheme and which this host serves", () =>
      withService(async ({ client }) => {
        const served = new Set(registeredSchemes());
        const unserved = SCHEMES.find((scheme) => !served.has(scheme));
        if (unserved === undefined) throw new Error("this runtime serves every scheme");
        const remove = registerTransport(unserved, () => {
          throw new Error("never opened");
        });
        try {
          const adapters = await client.adapters.list();
          expect(adapters.map((adapter) => adapter.scheme)).toEqual([...SCHEMES]);
          expect(adapters.map((adapter) => adapter.available)).toEqual(
            SCHEMES.map((scheme) => served.has(scheme) || scheme === unserved),
          );
          expect(adapters.find((adapter) => adapter.scheme === "webbluetooth")).toMatchObject({
            platform: "browser",
            userPicksDevice: true,
          });
        } finally {
          remove();
        }
      }));

    it("starts a run through the collector and stops it with the clock's time", () =>
      withService(async ({ client, collector, clock }) => {
        const run = await client.runs.start({
          profile: "mercedes-w211",
          adapter: "ble://vLinker",
          notes: "idle",
          signals: ["battery"],
        });
        expect(run).toMatchObject({
          profile: "mercedes-w211",
          startedAt: clock.time,
          stoppedAt: null,
          notes: "idle",
        });
        expect(collector.started).toHaveLength(1);
        expect(collector.started[0]?.signals).toEqual(["battery"]);
        expect(collector.started[0]?.run).toEqual(run);
        clock.time += 4000;
        const stopped = await client.runs.stop({ runId: run.id });
        expect(stopped).toEqual({ ...run, stoppedAt: clock.time });
        expect(collector.stopped).toEqual([run.id]);
        await expect(client.runs.stop({ runId: run.id })).rejects.toMatchObject({
          code: "CONFLICT",
        });
        await expect(client.runs.stop({ runId: "nope" })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      }));

    it("removes the run it opened when the collector cannot start", () =>
      withService(async ({ client, collector }) => {
        collector.failWith = new Error("adapter unreachable");
        await expect(client.runs.start({ profile: "p", adapter: "ble://x" })).rejects.toMatchObject(
          {
            code: "INTERNAL_SERVER_ERROR",
            message: "could not start collecting: adapter unreachable",
          },
        );
        expect(await client.runs.list({})).toEqual([]);
      }));

    it("lists and reads stored runs", () =>
      withService(async ({ client, clock }) => {
        const first = await client.runs.start({ profile: "a", adapter: "ble://x" });
        clock.time += 1;
        const second = await client.runs.start({ profile: "b", adapter: "ble://x" });
        expect((await client.runs.list({})).map((run) => run.id)).toEqual([second.id, first.id]);
        expect((await client.runs.list({ profile: "a" })).map((run) => run.id)).toEqual([first.id]);
        expect(await client.runs.get({ runId: first.id })).toEqual(first);
        await expect(client.runs.get({ runId: "nope" })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await expect(client.runs.list({ limit: 0 })).rejects.toBeInstanceOf(Error);
      }));

    it("stores what the collector writes and answers samples and aggregates", () =>
      withService(async ({ client, collector, clock }) => {
        const run = await client.runs.start({ profile: "p", adapter: "ble://x" });
        const samples: Sample[] = [
          { runId: run.id, signal: "battery", unit: "V", timestamp: clock.time, value: 12 },
          { runId: run.id, signal: "battery", unit: "V", timestamp: clock.time + 1000, value: 14 },
          { runId: run.id, signal: "gear", unit: "", timestamp: clock.time + 500, value: "D" },
        ];
        await collector.sink?.write(samples);
        expect(await client.runs.samples({ runId: run.id })).toEqual([
          samples[0],
          samples[2],
          samples[1],
        ]);
        expect(await client.runs.samples({ runId: run.id, signal: "battery", limit: 1 })).toEqual([
          samples[0],
        ]);
        const aggregate = await client.runs.aggregate({ runId: run.id });
        expect(aggregate.map((row) => [row.signal, row.count, row.mean])).toEqual([
          ["battery", 2, 13],
          ["gear", 1, null],
        ]);
      }));

    it("exports a run as CSV and as JSON", () =>
      withService(async ({ client, collector, clock }) => {
        const run = await client.runs.start({ profile: "p", adapter: "ble://x" });
        await collector.sink?.write([
          { runId: run.id, signal: "battery", unit: "V", timestamp: clock.time, value: 12.5 },
        ]);
        const csv = await client.runs.export({ runId: run.id, format: "csv" });
        expect(csv).toMatchObject({
          filename: `obd-read-run-${run.id}.csv`,
          mediaType: "text/csv",
        });
        expect(csv.content).toBe(
          "time,elapsed (s),battery (V)\r\n2023-11-14T22:13:20.000Z,0.000,12.5\r\n",
        );
        const json = await client.runs.export({ runId: run.id, format: "json" });
        expect(json.mediaType).toBe("application/json");
        expect(JSON.parse(json.content)).toMatchObject({
          format: "obd-read-run",
          run,
          samples: [{ value: 12.5 }],
        });
        await expect(client.runs.export({ runId: "nope", format: "csv" })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      }));

    it("streams samples as they are collected, to every subscriber, filtered by run", () =>
      withService(async ({ client, collector, clock }) => {
        const one = await client.runs.start({ profile: "p", adapter: "ble://x" });
        const two = await client.runs.start({ profile: "p", adapter: "ble://y" });
        const everything = await client.live.samples({});
        const onlyOne = await client.live.samples({ runId: one.id });
        const sample = (runId: string, value: number): Sample => ({
          runId,
          signal: "n",
          unit: "",
          timestamp: clock.time + value,
          value,
        });
        const firstOfEverything = everything.next();
        const firstOfOne = onlyOne.next();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await collector.sink?.write([sample(two.id, 1), sample(one.id, 2), sample(one.id, 3)]);
        expect((await firstOfEverything).value).toEqual(sample(two.id, 1));
        expect((await everything.next()).value).toEqual(sample(one.id, 2));
        expect((await firstOfOne).value).toEqual(sample(one.id, 2));
        expect((await onlyOne.next()).value).toEqual(sample(one.id, 3));
        await everything.return();
        await onlyOne.return();
      }));

    it("does not replay stored samples to a new subscriber", () =>
      withService(async ({ client, collector, clock }) => {
        const run = await client.runs.start({ profile: "p", adapter: "ble://x" });
        const old: Sample = {
          runId: run.id,
          signal: "n",
          unit: "",
          timestamp: clock.time,
          value: 1,
        };
        await collector.sink?.write([old]);
        const live = await client.live.samples({ runId: run.id });
        const next = live.next();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const fresh: Sample = { ...old, timestamp: clock.time + 1, value: 2 };
        await collector.sink?.write([fresh]);
        expect((await next).value).toEqual(fresh);
        await live.return();
      }));

    it("imports a profile, replaces one of the same name and refuses a bad one", () =>
      withService(async ({ client }) => {
        const json = JSON.stringify(builtinProfileData("vag-mqb"));
        const imported = await client.profiles.import({ json });
        expect(imported).toMatchObject({ name: "vag-mqb", replaced: false });
        expect(await client.profiles.import({ json })).toMatchObject({ replaced: true });
        expect(await client.profiles.list()).toEqual(["vag-mqb"]);
        await expect(client.profiles.import({ json: "{" })).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
        await expect(client.profiles.import({ json: "{}" })).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
        expect(await client.profiles.list()).toEqual(["vag-mqb"]);
      }));
  });
}
