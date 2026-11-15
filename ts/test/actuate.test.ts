import { describe, expect, it } from "vitest";
import {
  ACTUATION_MAX_MS,
  ActuationError,
  GuardError,
  NegativeResponse,
  NoResponse,
  TESTER_PRESENT_MS,
  actuateCommand,
  fromHex,
  toUpperHex,
  type Sleep,
} from "../src/core/index.js";
import {
  CASES,
  ENGINE,
  openRig,
  unitFor,
  type ProtocolCase,
  type Rig,
} from "./helpers/unit-rig.js";
import type { KwpEcu, Responder, UdsEcu } from "./helpers/fake-elm.js";

const noSleep: Sleep = () => Promise.resolve();

/** A unit-level interruption, thrown from the hold the way a cancelled task or Ctrl-C would be. */
class Interrupted extends Error {
  override name = "Interrupted";
}

function raising(error: Error): Sleep {
  return () => Promise.reject(error);
}

/** A fake car whose engine unit answers actuation requests, unless told to refuse a service. */
class Car {
  readonly lines: string[] = [];
  readonly refused = new Set<number>();

  private constructor(
    readonly protocol: ProtocolCase,
    readonly rig: Rig,
    readonly ecu: KwpEcu | UdsEcu,
  ) {}

  static async open(protocol: ProtocolCase): Promise<Car> {
    const ecu = unitFor(protocol, false);
    const holder: { car?: Car } = {};
    const respond: Responder = (request) => {
      const service = request[0] ?? 0;
      if (holder.car?.refused.has(service) === true) {
        return [[ENGINE.responseId, Uint8Array.of(0x7f, service, 0x22)]];
      }
      return ecu.respond(request);
    };
    const car = new Car(protocol, await openRig(respond), ecu);
    holder.car = car;
    return car;
  }

  run(
    options: {
      start?: string;
      stop?: string;
      durationMs?: number;
      answer?: string;
      sleep?: Sleep;
    } = {},
  ): Promise<number> {
    return actuateCommand({
      elm: this.rig.elm,
      profile: this.protocol.profile,
      unit: ENGINE,
      request: fromHex(options.start ?? this.protocol.start),
      stop: fromHex(options.stop ?? this.protocol.stop),
      durationMs: options.durationMs ?? 10,
      out: (line) => this.lines.push(line),
      ask: () => Promise.resolve(options.answer ?? "yes"),
      sleep: options.sleep ?? noSleep,
    });
  }

  get actuationRequests(): string[] {
    return this.rig.core.requests.filter((line) => /^(30|2F)/.test(line));
  }

  get output(): string {
    return this.lines.join("\n");
  }
}

describe.each(CASES)("actuate ($label)", (protocol) => {
  it("starts, holds and stops", async () => {
    const car = await Car.open(protocol);
    expect(await car.run()).toBe(0);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
    expect(car.output).toContain(`start request: ${protocol.start}`);
    expect(car.output).toContain(`stop request: ${protocol.stop}`);
    expect(car.output).toContain("unit: engine (7E0 -> 7E8)");
    expect(car.output).toContain(
      `start reply: ${protocol.actuationReply}${protocol.start.slice(2)}`,
    );
    expect(car.output).toContain(`sending stop request ${protocol.stop}`);
    expect(car.lines.at(-1)).toBe("control handed back to the unit");
  });

  it("holds with the real clock when none is given", async () => {
    const car = await Car.open(protocol);
    expect(
      await actuateCommand({
        elm: car.rig.elm,
        profile: protocol.profile,
        unit: ENGINE,
        request: fromHex(protocol.start),
        stop: fromHex(protocol.stop),
        durationMs: 10,
        out: (line) => car.lines.push(line),
        ask: () => Promise.resolve("yes"),
      }),
    ).toBe(0);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
  });

  it("keeps the session open with tester present during a long hold", async () => {
    const car = await Car.open(protocol);
    const slept: number[] = [];
    expect(
      await car.run({
        durationMs: 5000,
        sleep: (milliseconds) => {
          slept.push(milliseconds);
          return Promise.resolve();
        },
      }),
    ).toBe(0);
    expect(slept.reduce((total, step) => total + step, 0)).toBe(5000);
    expect(Math.max(...slept)).toBeLessThanOrEqual(TESTER_PRESENT_MS);
    const requests = car.rig.core.requests;
    const held = requests.slice(
      requests.indexOf(protocol.start) + 1,
      requests.indexOf(protocol.stop),
    );
    expect(held).toEqual(Array<string>(slept.length - 1).fill(protocol.testerPresent));
  });

  it.each(["", "y", "no", "YES", "yes please"])(
    "sends no actuation when the prompt is answered %j",
    async (answer) => {
      const car = await Car.open(protocol);
      expect(await car.run({ answer })).toBe(1);
      expect(car.actuationRequests).toEqual([]);
      expect(car.lines.at(-1)).toBe("nothing sent");
    },
  );

  it("sends the stop request after a refused start", async () => {
    const car = await Car.open(protocol);
    car.refused.add(Number.parseInt(protocol.start.slice(0, 2), 16));
    // The refusal covers the service, so the stop request is refused too and says so.
    const status = car.run();
    await expect(status).rejects.toThrow(ActuationError);
    await expect(status).rejects.toThrow(/refused with code 22/);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
  });

  it("sends the stop request after a silent start", async () => {
    const car = await Car.open(protocol);
    const respond = car.rig.responders[ENGINE.requestId];
    if (respond === undefined) throw new Error("no responder");
    car.rig.responders[ENGINE.requestId] = (request) =>
      request.length > 0 && toUpperHex(request) === protocol.start ? [] : respond(request);
    await expect(car.run()).rejects.toThrow(NoResponse);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
  });

  it("sends the stop request after an error mid-test", async () => {
    const car = await Car.open(protocol);
    car.refused.add(0x3e);
    const status = car.run({ durationMs: 5000 });
    await expect(status).rejects.toThrow(NegativeResponse);
    await expect(status).rejects.toThrow(/refused with code 22/);
    const requests = car.rig.core.requests;
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
    expect(requests.indexOf(protocol.stop)).toBeGreaterThan(
      requests.indexOf(protocol.testerPresent),
    );
  });

  it.each([
    ["interrupted", new Interrupted("interrupted")],
    ["cancelled", Object.assign(new Error("cancelled"), { name: "AbortError" })],
    ["timed out", new Error("the hold timed out")],
  ])("sends the stop request after an interruption: %s", async (_name, interruption) => {
    const car = await Car.open(protocol);
    await expect(car.run({ sleep: raising(interruption) })).rejects.toBe(interruption);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
    expect(car.output).toContain(`stop reply: ${protocol.actuationReply}${protocol.stop.slice(2)}`);
  });

  it("reports a failed stop request with the earlier error", async () => {
    const car = await Car.open(protocol);
    const respond = car.rig.responders[ENGINE.requestId];
    if (respond === undefined) throw new Error("no responder");
    car.rig.responders[ENGINE.requestId] = (request) =>
      toUpperHex(request) === protocol.stop
        ? [[ENGINE.responseId, Uint8Array.of(0x7f, request[0] ?? 0, 0x22)]]
        : respond(request);
    const status = car.run({ sleep: raising(new Interrupted("interrupted")) });
    await expect(status).rejects.toThrow(ActuationError);
    await expect(status).rejects.toThrow(/Interrupted: interrupted.*switch the ignition off/);
    expect(car.actuationRequests).toEqual([protocol.start, protocol.stop]);
  });

  it.each([0, -1, ACTUATION_MAX_MS + 1])(
    "sends nothing for a duration of %d milliseconds",
    async (durationMs) => {
      const car = await Car.open(protocol);
      const status = car.run({ durationMs });
      await expect(status).rejects.toThrow(GuardError);
      await expect(status).rejects.toThrow(/at most/);
      expect(car.rig.core.requests).toEqual([]);
    },
  );

  it("sends nothing for a stop that names another identifier", async () => {
    const car = await Car.open(protocol);
    const stop = protocol.stop.slice(0, 2) + "FF" + protocol.stop.slice(4);
    await expect(car.run({ stop })).rejects.toThrow(/same identifier/);
    expect(car.rig.core.requests).toEqual([]);
  });

  it.each(["2701", "3101", "1101", "3B4201", "2E014201", "1002", "3480"])(
    "sends only the actuation service: %s refused",
    async (start) => {
      const car = await Car.open(protocol);
      const stop = start.slice(0, 2) + "00".repeat(start.length / 2);
      await expect(car.run({ start, stop })).rejects.toThrow(/not a/);
      expect(car.rig.core.requests).toEqual([]);
    },
  );
});
