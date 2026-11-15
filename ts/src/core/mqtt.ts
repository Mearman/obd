/**
 * Publish the values a live source reads, and the adapter voltage, to an MQTT broker.
 *
 * Home Assistant finds the values through MQTT discovery and shows them as sensors under one
 * device per adapter. The values come from the same source the live command reads, so nothing is
 * decoded or requested here that live would not request, and every request still passes the guard.
 *
 * Core stays platform-free, so the broker connection is an injected {@link Connect}: the
 * `mqtt/mqtt-js-client` module implements it with mqtt.js, which speaks TCP in Node and WebSockets
 * in a browser, and tests inject a fake.
 *
 * The broker credentials are never read here. The Node entry point reads
 * `OBD_READ_MQTT_USER` and `OBD_READ_MQTT_PASSWORD` ({@link USER_VARIABLE},
 * {@link PASSWORD_VARIABLE}) and a browser page asks the user at run time and never stores them;
 * either passes them to {@link brokerSettings}. Nothing printed, logged or published includes them:
 * {@link BrokerSettings} keeps them out of every enumerable property, so serialising or inspecting
 * the settings cannot show them.
 */

import { ElmError, type AdapterInfo } from "./elm.js";
import { sleep as realSleep } from "./time.js";
import type { LineSink } from "./unit-access.js";

/** The environment variable the Node entry point reads the broker user name from. */
export const USER_VARIABLE = "OBD_READ_MQTT_USER";

/** The environment variable the Node entry point reads the broker password from. */
export const PASSWORD_VARIABLE = "OBD_READ_MQTT_PASSWORD";

/**
 * The payloads of the availability topic. These are Home Assistant's defaults for
 * `payload_available` and `payload_not_available`
 * (https://www.home-assistant.io/integrations/mqtt/, "Using Availability topics"), so the discovery
 * payload does not repeat them.
 */
export const ONLINE = "online";
export const OFFLINE = "offline";

/**
 * Home Assistant accepts only these units for each device class
 * (https://www.home-assistant.io/integrations/sensor/, "Device class"), so a class is set only for
 * a unit that is one of its listed units. Any other unit is published with no device class.
 */
export const DEVICE_CLASSES: ReadonlyMap<string, string> = new Map([
  ["°C", "temperature"],
  ["V", "voltage"],
  ["kPa", "pressure"],
  ["km/h", "speed"],
]);

/** One published quantity: its label and unit (empty when it has none). */
export interface SensorColumn {
  readonly label: string;
  readonly unit: string;
}

/** The column the adapter voltage is published under. */
export const VOLTAGE_COLUMN: SensorColumn = { label: "adapter voltage", unit: "V" };

/** One value from a source: a number, text, or `null` for a value not read this time. */
export type MqttReading = string | number | null;

/** What the publisher reads each sample: the live command's source. */
export interface MqttSource {
  readonly columns: readonly SensorColumn[];
  /** Lines to show once before publishing. */
  readonly notes: readonly string[];
  /** One reading per column, in column order. */
  read(out: LineSink): Promise<readonly MqttReading[]>;
}

/** The broker could not be reached, refused the connection, or a publish failed. */
export class BrokerError extends Error {
  override name = "BrokerError";
}

/** One broker connection. */
export interface MqttConnection {
  /**
   * Sends one message at QoS 0, retained when `retain` is true.
   *
   * @throws BrokerError when the broker does not take it.
   */
  publish(topic: string, payload: string, options: { readonly retain: boolean }): Promise<void>;
  /** Disconnects cleanly. */
  close(): Promise<void>;
}

/** The message the broker publishes if the connection is lost without a clean disconnect. */
export interface Will {
  readonly topic: string;
  readonly payload: string;
  readonly retain: boolean;
}

/** The broker credentials; both are optional, and a password needs a user. */
export interface BrokerCredentials {
  readonly username?: string;
  readonly password?: string;
}

/**
 * Where and how to connect. The credentials are reachable only through the {@link username} and
 * {@link password} accessors, so they are in no enumerable property and cannot reach a log through
 * `JSON.stringify` or an object dump.
 */
export class BrokerSettings {
  readonly #username: string | undefined;
  readonly #password: string | undefined;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly clientId: string,
    readonly will: Will,
    readonly tls: boolean,
    credentials: BrokerCredentials = {},
  ) {
    this.#username = credentials.username;
    this.#password = credentials.password;
  }

  /** The user name, when there is one. */
  get username(): string | undefined {
    return this.#username;
  }

  /** The password, when there is one. */
  get password(): string | undefined {
    return this.#password;
  }
}

/**
 * Opens a connection with the last-will message registered.
 *
 * @throws BrokerError when the broker cannot be reached or refuses the connection.
 */
export type Connect = (settings: BrokerSettings) => Promise<MqttConnection>;

/**
 * Lower-cases `text` as a run of letters, digits and underscores.
 *
 * Home Assistant allows only letters, digits, underscore and hyphen in a discovery topic's object id
 * (https://www.home-assistant.io/integrations/mqtt/, "Discovery topic").
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** One published value: where its state goes and how Home Assistant should show it. */
export interface Sensor {
  readonly column: SensorColumn;
  readonly key: string;
  readonly stateTopic: string;
  readonly discoveryTopic: string;
  /** The retained discovery payload, as JSON. */
  readonly config: string;
}

/**
 * The elements of both arrays, paired by position.
 *
 * @throws RangeError when the lengths differ, which means a source read the wrong number of values.
 */
function pairStrict<A, B>(first: readonly A[], second: readonly B[]): [A, B][] {
  const mismatch = new RangeError(
    `${String(first.length)} items cannot be paired with ${String(second.length)}`,
  );
  const rest = second[Symbol.iterator]();
  const pairs: [A, B][] = [];
  for (const item of first) {
    const next = rest.next();
    if (next.done === true) throw mismatch;
    pairs.push([item, next.value]);
  }
  if (rest.next().done !== true) throw mismatch;
  return pairs;
}

/** One distinct topic-safe key per column, from its label; a repeated label gets a number. */
export function uniqueKeys(columns: readonly SensorColumn[]): string[] {
  const keys: string[] = [];
  for (const column of columns) {
    const base = slug(column.label) || "value";
    let key = base;
    let number = 1;
    while (keys.includes(key)) {
      number += 1;
      key = `${base}_${String(number)}`;
    }
    keys.push(key);
  }
  return keys;
}

/** What {@link buildSensors} needs. */
export interface SensorOptions {
  readonly prefix: string;
  readonly discoveryPrefix: string;
  readonly deviceId: string;
  readonly adapter: AdapterInfo;
  /** Milliseconds between samples. */
  readonly intervalMs: number;
}

/**
 * The sensors for `columns`, each with its retained discovery payload.
 *
 * Every payload field is a documented sensor or device option of Home Assistant's MQTT integration
 * (https://www.home-assistant.io/integrations/sensor.mqtt/ and
 * https://www.home-assistant.io/integrations/mqtt/).
 */
export function buildSensors(columns: readonly SensorColumn[], options: SensorOptions): Sensor[] {
  const { prefix, discoveryPrefix, deviceId, adapter, intervalMs } = options;
  const availabilityTopic = `${prefix}/${deviceId}/availability`;
  return pairStrict(columns, uniqueKeys(columns)).map(([column, key]) => {
    // unique_id is required for discovered entities, and the guide recommends it as the topic's
    // object id with no node id.
    const uniqueId = `${deviceId}_${key}`;
    const stateTopic = `${prefix}/${deviceId}/${key}`;
    const config: Record<string, unknown> = {
      name: column.label,
      unique_id: uniqueId,
      state_topic: stateTopic,
      availability_topic: availabilityTopic,
      // The device map ties every sensor of one adapter to one device in the registry;
      // identifiers is what makes it the same device across restarts.
      device: {
        identifiers: [deviceId],
        name: `obd-read ${adapter.identity}`,
        model: adapter.identity,
      },
    };
    if (column.unit !== "") {
      config.unit_of_measurement = column.unit;
      // A state class marks a quantity worth long-term statistics; a reading with a unit is a
      // measurement, one with none may be text, which a state class would reject.
      config.state_class = "measurement";
      const deviceClass = DEVICE_CLASSES.get(column.unit);
      if (deviceClass !== undefined) config.device_class = deviceClass;
    }
    if (intervalMs > 0) {
      // After this many seconds with no update the state becomes unavailable, so a value the car
      // stopped answering does not stay on screen as current. Three intervals tolerate two missed
      // samples.
      config.expire_after = Math.ceil((intervalMs * 3) / 1000);
    }
    return {
      column,
      key,
      stateTopic,
      discoveryTopic: `${discoveryPrefix}/sensor/${uniqueId}/config`,
      config: JSON.stringify(config),
    };
  });
}

/**
 * Formats a finite number as C's `%.{precision}g` does: that many significant digits, trailing
 * zeros removed, an exponent only below 1e-4 or from 10^precision.
 */
function formatGeneral(value: number, precision: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "", exponentText = "0"] = value.toExponential(precision - 1).split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= precision) {
    const digits = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
    const sign = exponent < 0 ? "-" : "+";
    return `${digits}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const fixed = value.toFixed(precision - 1 - exponent);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** The text published for one reading, or `null` for a value not read this time. */
export function statePayload(reading: MqttReading): string | null {
  if (reading === null) return null;
  return typeof reading === "string" ? reading : formatGeneral(reading, 10);
}

/**
 * The connection settings, with the credentials as given and nowhere else.
 *
 * An empty user name or password counts as absent.
 *
 * @throws RangeError for a password with no user, since MQTT 3.1.1 does not allow one.
 */
export function brokerSettings(
  options: Pick<MqttOptions, "brokerHost" | "brokerPort" | "tls">,
  deviceId: string,
  availabilityTopic: string,
  credentials: BrokerCredentials = {},
): BrokerSettings {
  const username = credentials.username === "" ? undefined : credentials.username;
  const password = credentials.password === "" ? undefined : credentials.password;
  if (password !== undefined && username === undefined) {
    throw new RangeError(`${PASSWORD_VARIABLE} is set but ${USER_VARIABLE} is not`);
  }
  return new BrokerSettings(
    options.brokerHost,
    options.brokerPort,
    `obd-read-${deviceId}`,
    { topic: availabilityTopic, payload: OFFLINE, retain: true },
    options.tls,
    {
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
    },
  );
}

/** The options of the mqtt command. The broker credentials are deliberately not among them. */
export interface MqttOptions {
  /** The adapter's address, which names the device when no device identifier is given. */
  readonly adapter: string;
  readonly brokerHost: string;
  readonly brokerPort: number;
  readonly tls: boolean;
  /** Prefix of the state topics. */
  readonly topicPrefix: string;
  /** Home Assistant's MQTT discovery prefix. */
  readonly discoveryPrefix: string;
  /** Identifier of the Home Assistant device; derived from the adapter when absent. */
  readonly deviceId?: string;
  /** Milliseconds between samples. */
  readonly intervalMs: number;
  /** Samples to publish; 0 keeps going until stopped. */
  readonly count: number;
}

/**
 * Checks the options a broker or Home Assistant would reject.
 *
 * @throws RangeError naming the command-line option at fault.
 */
export function validate(options: MqttOptions): void {
  if (options.count < 0) throw new RangeError("--count must not be negative");
  if (!(options.intervalMs > 0)) throw new RangeError("--interval must be positive");
  if (!(options.brokerPort > 0 && options.brokerPort < 65536)) {
    throw new RangeError("--broker-port must be between 1 and 65535");
  }
  for (const [flag, text] of [
    ["--topic-prefix", options.topicPrefix],
    ["--discovery-prefix", options.discoveryPrefix],
  ] as const) {
    if (
      text === "" ||
      text.includes("+") ||
      text.includes("#") ||
      text.startsWith("/") ||
      text.endsWith("/")
    ) {
      throw new RangeError(
        `${flag} must be a topic with no wildcard and no leading or trailing slash`,
      );
    }
  }
  if (options.deviceId !== undefined && slug(options.deviceId) !== options.deviceId) {
    throw new RangeError("--device-id may hold only lower-case letters, digits and underscores");
  }
}

/**
 * One reading per source column, followed by the adapter voltage when `readVoltage` is given.
 *
 * A voltage that fails with an {@link ElmError} is reported once through `reported` and `out`, and
 * is `null` in that sample.
 */
export async function readAll(
  source: MqttSource,
  readVoltage: (() => Promise<MqttReading>) | undefined,
  out: LineSink,
  reported: Set<string>,
): Promise<readonly MqttReading[]> {
  const readings = await source.read(out);
  if (readVoltage === undefined) return readings;
  let volts: MqttReading;
  try {
    volts = await readVoltage();
  } catch (error) {
    if (!(error instanceof ElmError)) throw error;
    // Say so once; an adapter that cannot report a voltage cannot on any sample.
    if (!reported.has("voltage")) {
      reported.add("voltage");
      out(`adapter voltage not read: ${error.message}`);
    }
    volts = null;
  }
  return [...readings, volts];
}

/** What {@link runMqtt} needs. */
export interface RunMqttParams {
  readonly source: MqttSource;
  readonly adapter: AdapterInfo;
  readonly options: MqttOptions;
  readonly connect: Connect;
  /** The broker credentials, from the environment in Node or typed by the user in a page. */
  readonly credentials?: BrokerCredentials;
  /** Reads the adapter voltage, throwing ElmError when it cannot; absent publishes no voltage. */
  readonly readVoltage?: () => Promise<MqttReading>;
  readonly out: LineSink;
  /** Ends the run before the next sample once `aborted` is true; an `AbortSignal` fits. */
  readonly signal?: { readonly aborted: boolean };
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Publishes what the source reads, and the voltage, every `intervalMs` milliseconds.
 *
 * Prints the broker address and the sensor count, never the credentials. Publishes `offline` on
 * every way out once `online` was sent, then closes the connection.
 *
 * @returns 1 when the broker cannot be reached or fails, 0 otherwise.
 * @throws RangeError for a bad option, or a password with no user.
 */
export async function runMqtt(params: RunMqttParams): Promise<number> {
  const { source, adapter, options, connect, readVoltage, out, signal } = params;
  const sleep = params.sleep ?? realSleep;
  validate(options);
  const columns = [...source.columns, ...(readVoltage === undefined ? [] : [VOLTAGE_COLUMN])];
  const deviceId = options.deviceId ?? (slug(options.adapter) || "adapter");
  const sensors = buildSensors(columns, {
    prefix: options.topicPrefix,
    discoveryPrefix: options.discoveryPrefix,
    deviceId,
    adapter,
    intervalMs: options.intervalMs,
  });
  const availabilityTopic = `${options.topicPrefix}/${deviceId}/availability`;
  const settings = brokerSettings(options, deviceId, availabilityTopic, params.credentials);
  for (const note of source.notes) out(note);
  out(
    `publishing ${String(sensors.length)} sensors to ${options.brokerHost}:` +
      `${String(options.brokerPort)} under ${options.topicPrefix}/${deviceId}, discovery under ` +
      options.discoveryPrefix,
  );
  const reported = new Set<string>();
  const stopped = (): boolean => signal?.aborted === true;
  try {
    const connection = await connect(settings);
    try {
      for (const sensor of sensors) {
        await connection.publish(sensor.discoveryTopic, sensor.config, { retain: true });
      }
      await connection.publish(availabilityTopic, ONLINE, { retain: true });
      try {
        for (let index = 0; options.count === 0 || index < options.count; index++) {
          if (stopped()) break;
          if (index > 0) await sleep(options.intervalMs);
          if (stopped()) break;
          const readings = await readAll(source, readVoltage, out, reported);
          for (const [sensor, reading] of pairStrict(sensors, readings)) {
            const payload = statePayload(reading);
            if (payload !== null) {
              await connection.publish(sensor.stateTopic, payload, { retain: false });
            }
          }
        }
      } finally {
        // A clean disconnect does not make the broker send the last will, so say offline here; the
        // will covers a lost connection.
        await connection.publish(availabilityTopic, OFFLINE, { retain: true });
      }
    } finally {
      await connection.close();
    }
  } catch (error) {
    if (!(error instanceof BrokerError)) throw error;
    out(`error: ${error.message}`);
    return 1;
  }
  return 0;
}
