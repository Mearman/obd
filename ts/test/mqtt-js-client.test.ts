import type { IClientOptions } from "mqtt";
import { describe, expect, it } from "vitest";
import { BrokerError, BrokerSettings } from "../src/core/index.js";
import { mqttJsConnect, type OpenClient } from "../src/mqtt/mqtt-js-client.js";

const SETTINGS = new BrokerSettings(
  "broker.local",
  1883,
  "obd-read-x",
  { topic: "obd-read/x/availability", payload: "offline", retain: true },
  false,
  { username: "made-up-user", password: "made-up-password" },
);

interface Calls {
  url?: string;
  options?: IClientOptions;
  published: [string, string, unknown][];
  ended: boolean;
}

/** A stand-in for the part of an mqtt.js client the module uses. */
function fakeOpen(
  calls: Calls,
  behaviour: { publish?: Error; end?: Error; open?: Error } = {},
): OpenClient {
  return (url, options) => {
    calls.url = url;
    calls.options = options;
    if (behaviour.open !== undefined) return Promise.reject(behaviour.open);
    const client = {
      publishAsync: (
        topic: string,
        payload: string,
        publishOptions: { qos: 0; retain: boolean },
      ) => {
        if (behaviour.publish !== undefined) return Promise.reject(behaviour.publish);
        calls.published.push([topic, payload, publishOptions]);
        return Promise.resolve(undefined);
      },
      endAsync: () => {
        if (behaviour.end !== undefined) return Promise.reject(behaviour.end);
        calls.ended = true;
        return Promise.resolve();
      },
    };
    return Promise.resolve(client);
  };
}

function newCalls(): Calls {
  return { published: [], ended: false };
}

describe("mqttJsConnect", () => {
  it("opens a TCP client with the will, credentials and no reconnection", async () => {
    const calls = newCalls();
    await mqttJsConnect({ open: fakeOpen(calls) })(SETTINGS);
    expect(calls.url).toBe("mqtt://broker.local:1883");
    expect(calls.options).toMatchObject({
      clientId: "obd-read-x",
      username: "made-up-user",
      password: "made-up-password",
      reconnectPeriod: 0,
      will: { topic: "obd-read/x/availability", payload: "offline", qos: 0, retain: true },
    });
  });

  it("chooses the scheme from TLS and WebSocket", async () => {
    const tls = new BrokerSettings("h", 8883, "c", SETTINGS.will, true);
    for (const [websocket, expected] of [
      [false, "mqtts://h:8883"],
      [true, "wss://h:8883"],
    ] as const) {
      const calls = newCalls();
      await mqttJsConnect({ websocket, open: fakeOpen(calls) })(tls);
      expect(calls.url).toBe(expected);
      expect(calls.options).not.toHaveProperty("username");
    }
  });

  it("publishes at QoS 0 and closes", async () => {
    const calls = newCalls();
    const connection = await mqttJsConnect({ open: fakeOpen(calls) })(SETTINGS);
    await connection.publish("t", "p", { retain: true });
    await connection.close();
    expect(calls.published).toEqual([["t", "p", { qos: 0, retain: true }]]);
    expect(calls.ended).toBe(true);
  });

  it("reports a failure to connect, publish or close as a BrokerError without the password", async () => {
    await expect(
      mqttJsConnect({ open: fakeOpen(newCalls(), { open: new Error("refused") }) })(SETTINGS),
    ).rejects.toThrow(/broker broker.local:1883: refused/);
    const publishing = await mqttJsConnect({
      open: fakeOpen(newCalls(), { publish: new Error("gone") }),
    })(SETTINGS);
    await expect(publishing.publish("t", "p", { retain: false })).rejects.toThrow(BrokerError);
    const closing = await mqttJsConnect({ open: fakeOpen(newCalls(), { end: new Error("gone") }) })(
      SETTINGS,
    );
    await expect(closing.close()).rejects.toThrow(BrokerError);
  });
});
