import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BrokerError,
  BrokerSettings,
  ElmError,
  PASSWORD_VARIABLE,
  USER_VARIABLE,
  brokerSettings,
  buildSensors,
  runMqtt,
  slug,
  statePayload,
  uniqueKeys,
  type AdapterInfo,
  type Connect,
  type MqttOptions,
  type MqttReading,
  type MqttSource,
  type SensorColumn,
} from "../src/core/index.js";

/** Parses JSON text that must be an object. */
function parseObject(text: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text ?? "null");
  if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
  return Object.fromEntries(Object.entries(parsed));
}

const SECRET = "hunter2-made-up-password";
const USER = "made-up-user";

const ADAPTER: AdapterInfo = {
  identity: "ELM327 v2.3",
  description: null,
  stnIdentity: null,
  voltage: null,
  hasStnExtensions: false,
};

const FUEL: SensorColumn = { label: "fuel tank level", unit: "%" };
const BOOST: SensorColumn = { label: "boost pressure", unit: "kPa" };

interface Message {
  readonly topic: string;
  readonly payload: string;
  readonly retain: boolean;
}

/** A recording stand-in for a broker connection: the settings it was given and what was published. */
class FakeBroker {
  settings: BrokerSettings | undefined;
  readonly messages: Message[] = [];
  closed = false;

  constructor(private readonly failAfter?: number) {}

  readonly connect: Connect = (settings) => {
    this.settings = settings;
    return Promise.resolve({
      publish: (topic, payload, { retain }) => {
        if (this.failAfter !== undefined && this.messages.length >= this.failAfter) {
          return Promise.reject(new BrokerError("connection lost"));
        }
        this.messages.push({ topic, payload, retain });
        return Promise.resolve();
      },
      close: () => {
        this.closed = true;
        return Promise.resolve();
      },
    });
  };

  on(topic: string): Message[] {
    return this.messages.filter((message) => message.topic === topic);
  }
}

/** A source returning fixed readings, as the live command's source would. */
function source(
  columns: readonly SensorColumn[],
  readings: readonly MqttReading[],
  notes: readonly string[] = [],
): MqttSource {
  return { columns, notes, read: () => Promise.resolve(readings) };
}

const OPTIONS: MqttOptions = {
  adapter: "tcp://fake:1",
  brokerHost: "broker.local",
  brokerPort: 1883,
  tls: false,
  topicPrefix: "obd-read",
  discoveryPrefix: "homeassistant",
  intervalMs: 10_000,
  count: 1,
};

class Rig {
  readonly broker: FakeBroker;
  readonly lines: string[] = [];

  constructor(failAfter?: number) {
    this.broker = new FakeBroker(failAfter);
  }

  run(
    options: Partial<MqttOptions>,
    params: {
      source?: MqttSource;
      volts?: () => Promise<MqttReading>;
      noVoltage?: boolean;
      signal?: { readonly aborted: boolean };
      credentials?: { username?: string; password?: string };
    } = {},
  ): Promise<number> {
    return runMqtt({
      source: params.source ?? source([FUEL], [34.90196078431373]),
      adapter: ADAPTER,
      options: { ...OPTIONS, ...options },
      connect: this.broker.connect,
      out: (line) => this.lines.push(line),
      sleep: () => Promise.resolve(),
      ...(params.noVoltage === true
        ? {}
        : { readVoltage: params.volts ?? (() => Promise.resolve(12.4)) }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.credentials === undefined ? {} : { credentials: params.credentials }),
    });
  }

  get output(): string {
    return this.lines.join("\n");
  }
}

describe("runMqtt", () => {
  it("publishes values and voltage with discovery", async () => {
    const rig = new Rig();
    expect(await rig.run({})).toBe(0);
    const config = rig.broker.on("homeassistant/sensor/tcp_fake_1_fuel_tank_level/config");
    expect(config).toHaveLength(1);
    expect(config[0]?.retain).toBe(true);
    const payload = parseObject(config[0]?.payload ?? "{}");
    expect(payload.unit_of_measurement).toBe("%");
    expect(payload.state_class).toBe("measurement");
    expect(payload).not.toHaveProperty("device_class");
    expect(payload.unique_id).toBe("tcp_fake_1_fuel_tank_level");
    expect(payload.state_topic).toBe("obd-read/tcp_fake_1/fuel_tank_level");
    expect(payload.availability_topic).toBe("obd-read/tcp_fake_1/availability");
    expect(payload.device).toMatchObject({ identifiers: ["tcp_fake_1"] });
    expect(payload.expire_after).toBe(30);
    const voltage = parseObject(
      rig.broker.on("homeassistant/sensor/tcp_fake_1_adapter_voltage/config")[0]?.payload ?? "{}",
    );
    expect([voltage.unit_of_measurement, voltage.device_class]).toEqual(["V", "voltage"]);
    expect(rig.broker.on("obd-read/tcp_fake_1/fuel_tank_level")[0]?.payload).toBe("34.90196078");
    expect(rig.broker.on("obd-read/tcp_fake_1/adapter_voltage")[0]?.payload).toBe("12.4");
    expect(rig.broker.on("obd-read/tcp_fake_1/fuel_tank_level")[0]?.retain).toBe(false);
  });

  it("goes online then offline with a retained will, discovery first", async () => {
    const rig = new Rig();
    expect(await rig.run({})).toBe(0);
    const availability = rig.broker.on("obd-read/tcp_fake_1/availability");
    expect(availability.map((m) => [m.payload, m.retain])).toEqual([
      ["online", true],
      ["offline", true],
    ]);
    expect(rig.broker.settings?.will).toEqual({
      topic: "obd-read/tcp_fake_1/availability",
      payload: "offline",
      retain: true,
    });
    const topics = rig.broker.messages.map((m) => m.topic);
    expect(topics.indexOf("homeassistant/sensor/tcp_fake_1_fuel_tank_level/config")).toBeLessThan(
      topics.indexOf("obd-read/tcp_fake_1/fuel_tank_level"),
    );
    expect(rig.broker.closed).toBe(true);
  });

  it("says once that the voltage was not read, and publishes offline when the run fails", async () => {
    const rig = new Rig();
    const volts = (): Promise<MqttReading> => Promise.reject(new ElmError("no voltage"));
    expect(await rig.run({ count: 2, intervalMs: 10 }, { volts })).toBe(0);
    expect(rig.output.split("adapter voltage not read").length - 1).toBe(1);
    expect(rig.broker.on("obd-read/tcp_fake_1/adapter_voltage")).toHaveLength(0);
    const broken = new Rig(4);
    expect(await broken.run({ count: 3, intervalMs: 10 })).toBe(1);
    expect(broken.output).toContain("error: connection lost");
    expect(broken.broker.closed).toBe(true);
  });

  it("lets the options set the topics and the device", async () => {
    const rig = new Rig();
    expect(
      await rig.run(
        {
          topicPrefix: "car",
          discoveryPrefix: "ha",
          deviceId: "w211",
          brokerPort: 8883,
          tls: true,
        },
        { noVoltage: true },
      ),
    ).toBe(0);
    expect(rig.broker.on("ha/sensor/w211_fuel_tank_level/config")).toHaveLength(1);
    expect(rig.broker.on("car/w211/fuel_tank_level")).toHaveLength(1);
    expect(rig.broker.on("ha/sensor/w211_adapter_voltage/config")).toHaveLength(0);
    const settings = rig.broker.settings;
    expect([settings?.host, settings?.port, settings?.tls]).toEqual(["broker.local", 8883, true]);
  });

  it("gives a known unit a device class and prints the source's notes", async () => {
    const rig = new Rig();
    const boost = source(
      [BOOST, { label: "rail temperature", unit: "°C" }],
      [260, -45],
      ["unconfirmed identifiers"],
    );
    expect(await rig.run({}, { source: boost })).toBe(0);
    const config = parseObject(
      rig.broker.on("homeassistant/sensor/tcp_fake_1_boost_pressure/config")[0]?.payload ?? "{}",
    );
    expect(config.device_class).toBe("pressure");
    expect(rig.broker.on("obd-read/tcp_fake_1/boost_pressure")[0]?.payload).toBe("260");
    expect(rig.broker.on("obd-read/tcp_fake_1/rail_temperature")[0]?.payload).toBe("-45");
    expect(rig.output).toContain("unconfirmed identifiers");
  });

  it("does not publish a value that was not read", async () => {
    const rig = new Rig();
    expect(await rig.run({}, { source: source([FUEL], [null]) })).toBe(0);
    expect(rig.broker.on("obd-read/tcp_fake_1/fuel_tank_level")).toHaveLength(0);
  });

  it("stops before the next sample once the signal is aborted", async () => {
    const rig = new Rig();
    const signal = { aborted: false };
    const counting: MqttSource = {
      columns: [FUEL],
      notes: [],
      read: () => {
        signal.aborted = true;
        return Promise.resolve([1]);
      },
    };
    expect(await rig.run({ count: 0 }, { source: counting, noVoltage: true, signal })).toBe(0);
    // Without the signal a count of 0 would never finish; the run took exactly one sample.
    expect(rig.broker.on("obd-read/tcp_fake_1/fuel_tank_level")).toHaveLength(1);
  });

  it("refuses a source that reads the wrong number of values", async () => {
    const rig = new Rig();
    await expect(rig.run({}, { source: source([FUEL], [1, 2]), noVoltage: true })).rejects.toThrow(
      RangeError,
    );
    expect(rig.broker.on("obd-read/tcp_fake_1/availability").map((m) => m.payload)).toEqual([
      "online",
      "offline",
    ]);
  });
});

describe("credentials", () => {
  it("come from the caller and are never shown", async () => {
    const rig = new Rig();
    expect(await rig.run({}, { credentials: { username: USER, password: SECRET } })).toBe(0);
    const settings = rig.broker.settings;
    expect([settings?.username, settings?.password]).toEqual([USER, SECRET]);
    const everything = [
      rig.output,
      JSON.stringify(settings),
      inspect(settings, { showHidden: true, depth: 5 }),
      ...rig.broker.messages.map((m) => m.topic + m.payload),
    ];
    for (const text of everything) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(USER);
    }
  });

  it("are not echoed by a failure", async () => {
    const rig = new Rig(0);
    expect(await rig.run({}, { credentials: { username: USER, password: SECRET } })).toBe(1);
    expect(rig.output).not.toContain(SECRET);
  });

  it("refuse a password without a user, before connecting", async () => {
    const rig = new Rig();
    const status = rig.run({}, { credentials: { password: SECRET } });
    await expect(status).rejects.toThrow(`${PASSWORD_VARIABLE} is set but ${USER_VARIABLE} is not`);
    await expect(status).rejects.not.toThrow(SECRET);
    expect(rig.broker.settings).toBeUndefined();
  });

  it("treat an empty value as absent", () => {
    const settings = brokerSettings(OPTIONS, "d", "t", { username: "", password: "" });
    expect([settings.username, settings.password]).toEqual([undefined, undefined]);
  });

  it("are carried by BrokerSettings only through its accessors", () => {
    const settings = new BrokerSettings(
      "h",
      1883,
      "c",
      { topic: "t", payload: "offline", retain: true },
      false,
      { username: USER, password: SECRET },
    );
    expect(Object.keys(settings)).not.toContain("username");
    expect(Object.values(settings).map(String).join()).not.toContain(SECRET);
  });
});

describe.each([
  [{ intervalMs: 0 }, "--interval must be positive"],
  [{ count: -1 }, "--count must not be negative"],
  [{ brokerPort: 0 }, "--broker-port must be between"],
  [{ topicPrefix: "a/#" }, "--topic-prefix must be a topic"],
  [{ discoveryPrefix: "/ha" }, "--discovery-prefix must be a topic"],
  [{ deviceId: "My Car" }, "--device-id may hold only"],
])("bad option %j", (change, message) => {
  it("is refused before connecting", async () => {
    const rig = new Rig();
    await expect(rig.run(change)).rejects.toThrow(message);
    expect(rig.broker.settings).toBeUndefined();
  });
});

describe("naming", () => {
  it("slug keeps topic-safe characters only", () => {
    expect(slug("ble://vLinker MC+")).toBe("ble_vlinker_mc");
    expect(slug("boost pressure, actual")).toBe("boost_pressure_actual");
  });

  it("numbers a repeated label", () => {
    expect(uniqueKeys([FUEL, FUEL, { label: "!!", unit: "" }])).toEqual([
      "fuel_tank_level",
      "fuel_tank_level_2",
      "value",
    ]);
  });

  it("omits the state class and expiry that do not apply", () => {
    const [sensor] = buildSensors([{ label: "gear", unit: "" }], {
      prefix: "p",
      discoveryPrefix: "d",
      deviceId: "x",
      adapter: ADAPTER,
      intervalMs: 0,
    });
    const config = parseObject(sensor?.config ?? "{}");
    expect(config).not.toHaveProperty("state_class");
    expect(config).not.toHaveProperty("unit_of_measurement");
    expect(config).not.toHaveProperty("expire_after");
  });
});

describe("statePayload", () => {
  it.each([
    [34.90196078431373, "34.90196078"],
    [260, "260"],
    [-45, "-45"],
    [0.5, "0.5"],
    [12.4, "12.4"],
    [1234567890123, "1.23456789e+12"],
    [0.00001234, "1.234e-05"],
    [0.0001234, "0.0001234"],
    [0, "0"],
  ])("formats %j as %j, as C's %.10g does", (value, text) => {
    expect(statePayload(value)).toBe(text);
  });

  it("passes text through and skips a missing value", () => {
    expect(statePayload("D")).toBe("D");
    expect(statePayload(null)).toBeNull();
  });
});
