import { describe, expect, it } from "vitest";
import {
  legislatedSource,
  type Sample,
  type Transport,
  type TransportHost,
} from "../src/core/index.js";
import { Car, RECORDED } from "./helpers/recorded-car.js";
import { loadReplies } from "./helpers/transcripts.js";
import {
  GENERIC_SIMULATOR,
  eventually,
  newSimulatedService,
  recordingGenericHost,
  turn,
} from "./support/host-rig.js";

/** A transport that can hold every write until released, counting the writes that start while it is released. */
class Gate implements Transport {
  /** The text of the request to hold, when one is. */
  holdOn: string | undefined;
  writes = 0;
  readonly log: string[] = [];
  private release: (() => void) | undefined;
  private blocked: Promise<void> | undefined;
  constructor(private readonly inner: Transport) {}

  open(): Promise<void> {
    return this.inner.open();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes += 1;
    const text = new TextDecoder().decode(data).trim();
    this.log.push(text);
    if (this.holdOn !== undefined && text.startsWith(this.holdOn)) {
      this.blocked ??= new Promise<void>((resolve) => {
        this.release = resolve;
      });
      await this.blocked;
    }
    await this.inner.write(data);
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    return this.inner.read(timeoutMs);
  }

  /** Whether a write is waiting for {@link Gate.let}. */
  get waiting(): boolean {
    return this.blocked !== undefined;
  }

  /** Lets the held write through and stops holding. */
  let(): void {
    this.holdOn = undefined;
    this.release?.();
  }
}

describe("a cycle of readings", () => {
  it("ends before the next request once it is told to stop, leaving the rest unread", async () => {
    const car = new Car(loadReplies(...RECORDED));
    const elm = await car.elm();
    const source = await legislatedSource(elm, []);
    expect(source.columns.length).toBeGreaterThan(3);
    const reads = (): number => car.core.requests.filter((line) => line.startsWith("01")).length;
    const before = reads();
    const seen: string[] = [];
    let stopAfter = 2;
    const readings = await source.read(() => undefined, {
      stopped: () => seen.length >= stopAfter,
      progress: (position, total, label) => {
        expect(total).toBe(source.available.length);
        expect(position).toBe(seen.length + 1);
        seen.push(label);
      },
      read: () => Promise.resolve(),
    });
    expect(seen).toHaveLength(stopAfter);
    expect(reads() - before).toBe(stopAfter);
    expect(readings).toHaveLength(source.columns.length);
    expect(readings.slice(stopAfter).every((reading) => reading === undefined)).toBe(true);
    stopAfter = Number.POSITIVE_INFINITY;
  });
});

describe("stopping a collection run", () => {
  it("sends no request after the one in flight and stores a consistent run", async () => {
    const rig = recordingGenericHost();
    const gates: Gate[] = [];
    const transports: TransportHost = {
      ...rig.transports,
      schemes: () => [],
      serves: (url) => rig.transports.serves(url),
      create: (url) => {
        const gate = new Gate(rig.transports.create(url));
        gates.push(gate);
        return gate;
      },
    };
    const service = newSimulatedService({ transports });
    const { client } = service.host;
    await client.link.connect({ adapter: GENERIC_SIMULATOR });
    const run = await client.runs.start({ adapter: GENERIC_SIMULATOR });
    const gate = gates.at(-1);
    if (gate === undefined) throw new Error("no transport was built");

    // The first value of a cycle is held in flight, so two more of its values and the fault code reads are still to come.
    gate.holdOn = "0105";
    await eventually(() => (gate.waiting ? true : undefined));
    const status = await client.runs.status({ runId: run.id });
    expect(status?.progress).toMatchObject({ position: 1, label: "coolant temperature" });
    expect(status?.progress?.total).toBe(3);
    const stopping = client.runs.stop({ runId: run.id });
    for (let pass = 0; pass < 20; pass++) await turn();
    const startedBeforeRelease = gate.writes;
    gate.let();
    const stopped = await stopping;

    expect(stopped.stoppedAt).not.toBeNull();
    expect(gate.log.slice(startedBeforeRelease)).toEqual([]);
    expect(await client.runs.status({ runId: run.id })).toBeNull();
    const stored = await service.storage.readSamples({ runId: run.id });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((sample) => sample.runId === run.id)).toBe(true);
  });
});

describe("a reading in a cycle still being read", () => {
  it("is stored and handed to live subscribers before the cycle's next value is answered", async () => {
    const rig = recordingGenericHost();
    const gates: Gate[] = [];
    const transports: TransportHost = {
      ...rig.transports,
      schemes: () => [],
      serves: (url) => rig.transports.serves(url),
      create: (url) => {
        const gate = new Gate(rig.transports.create(url));
        gates.push(gate);
        return gate;
      },
    };
    const service = newSimulatedService({ transports });
    const { client } = service.host;
    await client.link.connect({ adapter: GENERIC_SIMULATOR });
    const gate = gates.at(-1);
    if (gate === undefined) throw new Error("no transport was built");
    // Subscribed before the run starts: a subscription begins with its first request for a sample.
    const live = await client.live.samples({});
    const arriving = live.next();
    for (let pass = 0; pass < 5; pass++) await turn();
    // The second value of the first cycle, engine speed, is held in flight.
    gate.holdOn = "010C";
    const run = await client.runs.start({ adapter: GENERIC_SIMULATOR });
    await eventually(() => (gate.waiting ? true : undefined));

    const stored = await service.storage.readSamples({ runId: run.id });
    expect(stored.map((sample) => sample.signal)).toEqual(["coolant temperature"]);
    const first = await arriving;
    if (first.done === true) throw new Error("the live stream ended");
    expect(first.value).toMatchObject({ runId: run.id, signal: "coolant temperature" });

    gate.holdOn = undefined;
    gate.let();
    const cycle: Sample[] = [first.value];
    while (cycle.length < 3) {
      const next = await live.next();
      if (next.done === true) throw new Error("the live stream ended");
      cycle.push(next.value);
    }
    await live.return(undefined);
    await client.runs.stop({ runId: run.id });
    expect(cycle.map((sample) => sample.signal)).toEqual([
      "coolant temperature",
      "engine speed",
      "vehicle speed",
    ]);
    // A cycle's readings share one time, so an export lays them out as one row.
    expect(new Set(cycle.map((sample) => sample.timestamp)).size).toBe(1);
  });
});

describe("the values a car supports", () => {
  it("are listed with the time one request took, and need the adapter free", async () => {
    const rig = recordingGenericHost();
    const service = newSimulatedService({ transports: rig.transports });
    const { client } = service.host;
    await expect(client.runs.values()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await client.link.connect({ adapter: GENERIC_SIMULATOR });
    const listed = await client.runs.values();
    expect(listed.requestMs).toBeGreaterThanOrEqual(0);
    const names = listed.values.map((value) => value.name);
    expect(names).toContain("engine-speed");
    expect(listed.values.find((value) => value.name === "engine-speed")?.columns).toEqual([
      { label: "engine speed", unit: "rpm" },
    ]);
    const run = await client.runs.start({ adapter: GENERIC_SIMULATOR, signals: ["engine-speed"] });
    await expect(client.runs.values()).rejects.toMatchObject({ code: "CONFLICT" });
    await client.runs.stop({ runId: run.id });
  });
});
