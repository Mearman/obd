/**
 * The broker connection for {@link runMqtt}, implemented with mqtt.js. Not part of core: it
 * imports a platform library. mqtt.js speaks TCP in Node and WebSockets in a browser, so the same
 * module serves both; the caller chooses with `websocket`.
 *
 * Credentials arrive in the {@link BrokerSettings} the caller built. This module never reads the
 * environment: the Node entry point reads `OBD_READ_MQTT_USER` and `OBD_READ_MQTT_PASSWORD`, and a
 * browser page asks the user.
 */

import { connectAsync, type IClientOptions } from "mqtt";
import { BrokerError, type BrokerSettings, type Connect } from "../core/mqtt.js";

/** The two methods of an mqtt.js client this module calls. */
export interface ClientLike {
  publishAsync(
    topic: string,
    payload: string,
    options: { readonly qos: 0; readonly retain: boolean },
  ): Promise<unknown>;
  endAsync(): Promise<unknown>;
}

/** Opens a client; mqtt.js's own `connectAsync` unless a test substitutes one. */
export type OpenClient = (url: string, options: IClientOptions) => Promise<ClientLike>;

/** How {@link mqttJsConnect} reaches the broker. */
export interface MqttJsOptions {
  /**
   * Connect over WebSockets (`ws` or `wss`), which a browser requires and a broker must offer on
   * its port. Default: plain MQTT over TCP (`mqtt` or `mqtts`).
   */
  readonly websocket?: boolean;
  /** Substitutes the client factory, for tests. */
  readonly open?: OpenClient;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A {@link Connect} that opens an mqtt.js client with the last-will message registered and no
 * automatic reconnection, so a lost connection surfaces as a {@link BrokerError} instead of being
 * retried behind the caller.
 */
export function mqttJsConnect(options: MqttJsOptions = {}): Connect {
  const open = options.open ?? connectAsync;
  return async (settings: BrokerSettings) => {
    const scheme = options.websocket === true ? "ws" : "mqtt";
    const url = `${scheme}${settings.tls ? "s" : ""}://${settings.host}:${String(settings.port)}`;
    const clientOptions: IClientOptions = {
      clientId: settings.clientId,
      reconnectPeriod: 0,
      will: {
        topic: settings.will.topic,
        payload: settings.will.payload,
        qos: 0,
        retain: settings.will.retain,
      },
      ...(settings.username === undefined ? {} : { username: settings.username }),
      ...(settings.password === undefined ? {} : { password: settings.password }),
    };
    let client: ClientLike;
    try {
      client = await open(url, clientOptions);
    } catch (error) {
      throw new BrokerError(
        `broker ${settings.host}:${String(settings.port)}: ${describe(error)}`,
        {
          cause: error,
        },
      );
    }
    return {
      async publish(topic, payload, { retain }) {
        try {
          await client.publishAsync(topic, payload, { qos: 0, retain });
        } catch (error) {
          throw new BrokerError(`publishing to the broker failed: ${describe(error)}`, {
            cause: error,
          });
        }
      },
      async close() {
        try {
          await client.endAsync();
        } catch (error) {
          throw new BrokerError(`closing the broker connection failed: ${describe(error)}`, {
            cause: error,
          });
        }
      },
    };
  };
}
