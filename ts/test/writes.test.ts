import { describe, expect, it } from "vitest";
import {
  GuardError,
  NegativeResponse,
  UnitSession,
  WriteRefused,
  fromHex,
  makeClient,
  toUpperHex,
  unitSession,
  writeCommand,
  type WriteCommand,
} from "../src/core/index.js";
import type { KwpEcu, Responder, UdsEcu } from "./helpers/fake-elm.js";
import {
  CASES,
  ENGINE,
  WritableMemoryStore,
  openRig,
  unitFor,
  type ProtocolCase,
  type Rig,
} from "./helpers/unit-rig.js";

/** A fake car whose engine unit holds one writable record, and a record of what was said. */
class Car {
  readonly store = new WritableMemoryStore();
  readonly lines: string[] = [];
  asked = 0;
  private constructor(
    readonly protocol: ProtocolCase,
    readonly rig: Rig,
    readonly ecu: KwpEcu | UdsEcu,
  ) {}

  static async open(protocol: ProtocolCase, options: { records?: boolean } = {}): Promise<Car> {
    const ecu = unitFor(protocol, options.records ?? true);
    return new Car(protocol, await openRig(ecu.respond), ecu);
  }

  /** Runs the write or restore command, answering the prompt with `answer`. */
  run(command: WriteCommand, save: string, answer = "yes", before?: () => void): Promise<number> {
    return writeCommand(command, {
      elm: this.rig.elm,
      adapter: this.rig.adapter,
      profile: this.protocol.profile,
      unit: ENGINE,
      store: this.store,
      save,
      out: (line) => this.lines.push(line),
      ask: () => {
        this.asked += 1;
        before?.();
        return Promise.resolve(answer);
      },
    });
  }

  write(save: string, answer = "yes", request = this.protocol.write): Promise<number> {
    return this.run(
      { command: "write", request: fromHex(request), read: fromHex(this.protocol.read) },
      save,
      answer,
    );
  }

  restore(snapshot: string, save: string, answer = "yes"): Promise<number> {
    return this.run({ command: "restore", snapshot }, save, answer);
  }

  get record(): string {
    const record = this.ecu.records.get(this.protocol.recordKey);
    return record === undefined ? "" : toUpperHex(record);
  }

  get writesSent(): string[] {
    return this.rig.core.requests.filter((line) => /^(3B|2E)/.test(line));
  }

  get output(): string {
    return this.lines.join("\n");
  }

  get last(): string | undefined {
    return this.lines.at(-1);
  }

  async saved(name: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await this.store.readText(name));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return Object.fromEntries(Object.entries(parsed));
  }
}

describe.each(CASES)("write ($label)", (protocol) => {
  it("saves, confirms, writes once and reads back", async () => {
    const car = await Car.open(protocol);
    expect(await car.write("before.json")).toBe(0);
    const saved = await car.saved("before.json");
    expect(saved.kind).toBe("write");
    expect(saved.unit).toEqual({ name: "engine", request_id: "7E0", response_id: "7E8" });
    expect(saved.read_request).toBe(protocol.read);
    expect(saved.write_request).toBe(protocol.write);
    expect(saved.previous_value).toBe(protocol.previous);
    expect(saved.taken).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    expect(car.writesSent).toEqual([protocol.write]);
    const requests = car.rig.core.requests;
    expect(requests.indexOf(protocol.write)).toBeGreaterThan(requests.indexOf(protocol.read));
    expect(requests.slice(requests.indexOf(protocol.write) + 1)).toEqual([protocol.read]);
    expect(car.record).toBe(protocol.value);
    expect(car.asked).toBe(1);
    expect(car.output).toContain(`current value: ${protocol.previous}`);
    expect(car.output).toContain(`write request: ${protocol.write}`);
    expect(car.output).toContain("unit: engine (7E0 -> 7E8)");
    expect(car.output).toContain(`read back: ${protocol.value}`);
    expect(car.last).toBe("the value now matches the request");
  });

  it.each(["", "y", "no", "YES", "yes please"])(
    "sends no write when the prompt is answered %j",
    async (answer) => {
      const car = await Car.open(protocol);
      expect(await car.write("before.json", answer)).toBe(1);
      expect(car.writesSent).toEqual([]);
      expect(car.record).toBe(protocol.previous);
      expect(await car.store.exists("before.json")).toBe(true);
      expect(car.last).toBe("nothing written");
    },
  );

  it("sends nothing when the snapshot name is taken", async () => {
    const car = await Car.open(protocol);
    car.store.write("before.json", "an earlier snapshot");
    await expect(car.write("before.json")).rejects.toThrow(/already exists/);
    expect(car.rig.core.requests).toEqual([]);
    expect(await car.store.readText("before.json")).toBe("an earlier snapshot");
  });

  it("sends no write when the current value cannot be read", async () => {
    const car = await Car.open(protocol, { records: false });
    car.ecu.records.clear();
    const refusal = car.write("before.json");
    await expect(refusal).rejects.toThrow(WriteRefused);
    await expect(refusal).rejects.toThrow(/nothing written/);
    expect(car.writesSent).toEqual([]);
    expect(await car.store.exists("before.json")).toBe(false);
  });

  it("sends no write when the unit is silent", async () => {
    const car = await Car.open(protocol);
    car.rig.responders[ENGINE.requestId] = () => [];
    await expect(car.write("before.json")).rejects.toThrow(WriteRefused);
    expect(car.writesSent).toEqual([]);
    expect(await car.store.exists("before.json")).toBe(false);
  });

  it("sends nothing when the snapshot is removed before the write", async () => {
    const car = await Car.open(protocol);
    const status = car.run(
      { command: "write", request: fromHex(protocol.write), read: fromHex(protocol.read) },
      "before.json",
      "yes",
      () => {
        car.store.remove("before.json");
      },
    );
    await expect(status).rejects.toThrow(GuardError);
    await expect(status).rejects.toThrow(/has gone/);
    expect(car.writesSent).toEqual([]);
  });

  it.each([
    ["the read names another identifier", protocol.read.slice(0, -2) + "43"],
    ["the read is a different service", "1A86"],
  ])("sends nothing when %s", async (_name, read) => {
    const car = await Car.open(protocol);
    const status = car.run(
      { command: "write", request: fromHex(protocol.write), read: fromHex(read) },
      "s.json",
    );
    await expect(status).rejects.toThrow(GuardError);
    await expect(status).rejects.toThrow(/the read request must be/);
    expect(car.rig.core.requests).toEqual([]);
  });

  it.each(["2701", "3101", "1A86", "300A07", "2F012303", "1002"])(
    "sends only the write service: %s refused",
    async (request) => {
      const car = await Car.open(protocol);
      await expect(car.write("s.json", "yes", request)).rejects.toThrow(GuardError);
      expect(car.rig.core.requests).toEqual([]);
    },
  );

  it("reports a refused write", async () => {
    const car = await Car.open(protocol);
    car.ecu.writesRefused = true;
    const status = car.write("s.json");
    await expect(status).rejects.toThrow(NegativeResponse);
    await expect(status).rejects.toThrow(/refused with code 22/);
    expect(car.record).toBe(protocol.previous);
  });

  it("reports a value that reads back differently", async () => {
    const car = await Car.open(protocol);
    const respond: Responder = car.ecu.respond;
    car.rig.responders[ENGINE.requestId] = (request) => {
      const reply = respond(request);
      car.ecu.records.set(protocol.recordKey, fromHex(protocol.previous));
      return reply;
    };
    expect(await car.write("s.json")).toBe(1);
    expect(car.last).toContain("does not match the request");
    expect(car.last).toContain("s.json");
  });
});

describe.each(CASES)("restore ($label)", (protocol) => {
  it("writes back the saved value", async () => {
    const car = await Car.open(protocol);
    expect(await car.write("first.json")).toBe(0);
    expect(car.record).toBe(protocol.value);
    expect(await car.restore("first.json", "second.json")).toBe(0);
    expect(car.record).toBe(protocol.previous);
    const saved = await car.saved("second.json");
    expect(saved.previous_value).toBe(protocol.value);
    expect(saved.restores).toBe("first.json");
    const restoreWrite = protocol.write.slice(0, -protocol.value.length) + protocol.previous;
    expect(saved.write_request).toBe(restoreWrite);
    expect(car.writesSent).toEqual([protocol.write, restoreWrite]);
    expect(car.output).toContain("this puts back the value saved in first.json");
  });

  it("has the same safeguards", async () => {
    const car = await Car.open(protocol);
    expect(await car.write("first.json")).toBe(0);
    expect(await car.restore("first.json", "second.json", "no")).toBe(1);
    expect(car.writesSent).toEqual([protocol.write]);
    expect(await car.store.exists("second.json")).toBe(true);
    await expect(car.restore("first.json", "second.json")).rejects.toThrow(/already exists/);
    expect(car.writesSent).toEqual([protocol.write]);
    await expect(car.restore("first.json", "first.json")).rejects.toThrow(WriteRefused);
    expect(car.writesSent).toEqual([protocol.write]);
  });

  it("refuses a snapshot from another unit", async () => {
    const car = await Car.open(protocol);
    expect(await car.write("first.json")).toBe(0);
    const saved = await car.saved("first.json");
    car.store.write(
      "moved.json",
      JSON.stringify({
        ...saved,
        unit: { name: "gearbox", request_id: "7E0", response_id: "7E8" },
      }),
    );
    const before = car.writesSent.length;
    await expect(car.restore("moved.json", "r.json")).rejects.toThrow(/was taken from/);
    expect(car.writesSent).toHaveLength(before);
  });

  it("refuses a snapshot taken over another protocol", async () => {
    const car = await Car.open(protocol);
    expect(await car.write("first.json")).toBe(0);
    const saved = await car.saved("first.json");
    car.store.write("other.json", JSON.stringify({ ...saved, protocol: "obd" }));
    await expect(car.restore("other.json", "r.json")).rejects.toThrow(/was taken over obd/);
  });

  it("refuses a file that is not a write snapshot", async () => {
    const car = await Car.open(protocol);
    car.store.write("clear.json", JSON.stringify({ tool: "obd-read", units: [] }));
    await expect(car.restore("clear.json", "r.json")).rejects.toThrow(/not a write snapshot/);
    expect(car.writesSent).toEqual([]);
  });
});

describe.each(CASES)("read paths cannot write or actuate ($label)", (protocol) => {
  it.each(["3B420203", "2E01420203", "300A07", "2F012303"])(
    "refuses %s as a plain request and sends nothing",
    async (request) => {
      const car = await Car.open(protocol);
      const session = unitSession(car.rig.elm, protocol.profile, ENGINE);
      expect(session).toBeInstanceOf(UnitSession);
      await expect(session.request(fromHex(request))).rejects.toThrow(/refused/);
      expect(car.rig.core.requests).toEqual([]);
    },
  );

  it("reading identification, faults and freeze frames sends no write or actuation", async () => {
    const car = await Car.open(protocol);
    await car.rig.elm.addressUnit(ENGINE.requestId, ENGINE.responseId);
    const client = makeClient(car.rig.elm, protocol.profile, ENGINE);
    await client.start();
    await client.identification();
    const [fault] = await client.faults();
    if (fault === undefined) throw new Error("the fake unit reported no fault");
    await client.freezeFrame(fault);
    expect(car.writesSent).toEqual([]);
    expect(car.rig.core.requests.filter((line) => /^(30|2F)/.test(line))).toEqual([]);
  });
});
