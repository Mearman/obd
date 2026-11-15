/**
 * Builds, from a scenario's car, the scripted adapter the TypeScript command line is run against. The cars match those the goldens were recorded against.
 */

import {
  FakeElmCore,
  KwpEcu,
  RawCanTransport,
  ScriptedTransport,
  TransportError,
  TransportTimeout,
  UdsEcu,
  asciiDecode,
  asciiEncode,
  concatBytes,
  fromHex,
  simulatedTransport,
  adapterTransport,
  type FakeElmOptions,
  type Transport,
  type UnitResponder,
} from "../../src/core/index.js";
import { loadBuiltinProfile } from "../../src/profiles/index.js";
import { FakeCanLink } from "../helpers/fake-can.js";
import { FakeKLineCore, type KLineUnit } from "../helpers/fake-kline.js";
import type { CarSpec, UnitSpec } from "./scenarios.js";

function hexInt(text: string): number {
  return Number.parseInt(text, 16);
}

/** A scripted unit with the extras a scenario asks for around the stock behaviour. */
function unitResponder(spec: UnitSpec): UnitResponder {
  const faults = spec.faults.map(([code, status]): [number, number] => [
    hexInt(code),
    hexInt(status),
  ]);
  const response = hexInt(spec.response);
  const unit =
    spec.protocol === "uds" ? new UdsEcu(response, faults) : new KwpEcu(response, faults);
  unit.writesRefused = spec.writesRefused;
  if (unit instanceof KwpEcu) unit.freezeRefused = spec.freezeRefused;
  for (const [key, value] of Object.entries(spec.records)) {
    unit.records.set(hexInt(key), fromHex(value));
  }
  const values = new Map(
    Object.entries(spec.values).map(([key, value]): [number, Uint8Array] => [
      hexInt(key),
      fromHex(value),
    ]),
  );
  return (request) => {
    const [service = 0, high = 0, low = 0] = request;
    if (spec.refuseAll) return [[response, Uint8Array.of(0x7f, service, 0x11)]];
    if (values.size > 0 && service === 0x21 && request.length === 2) {
      const data = values.get(high);
      if (data === undefined) return [[response, Uint8Array.of(0x7f, 0x21, 0x31)]];
      return [[response, concatBytes(Uint8Array.of(0x61, high), data)]];
    }
    if (values.size > 0 && service === 0x22 && request.length === 3) {
      const data = values.get(high * 256 + low);
      if (data === undefined) return [[response, Uint8Array.of(0x7f, 0x22, 0x31)]];
      return [[response, concatBytes(Uint8Array.of(0x62, high, low), data)]];
    }
    return unit.respond(request);
  };
}

/** An adapter that never says anything. */
class SilentTransport implements Transport {
  open(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  write(): Promise<void> {
    return Promise.resolve();
  }

  read(): Promise<Uint8Array> {
    return Promise.reject(new TransportTimeout("the silent adapter says nothing"));
  }
}

/** An adapter whose link cannot be opened. */
class RefusingTransport extends SilentTransport {
  constructor(private readonly message: string) {
    super();
  }

  override open(): Promise<void> {
    return Promise.reject(new TransportError(this.message));
  }
}

/** A scripted adapter that streams frames after STM or ATMA until it is sent any byte. */
class MonitoringAdapter implements Transport {
  private monitoring = false;
  private output: Uint8Array = new Uint8Array(0);
  private readonly core: FakeElmCore;

  constructor(
    private readonly stream: readonly string[],
    stn: boolean,
  ) {
    this.core = new FakeElmCore({}, stn ? { stnIdentity: "STN1110 v4.2" } : {});
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.monitoring) {
      this.monitoring = false;
      this.output = concatBytes(this.output, asciiEncode("STOPPED\r\r>"));
      return Promise.resolve();
    }
    const text = asciiDecode(data).trim();
    if (text === "STM" || text === "ATMA") {
      this.core.sent.push(text);
      this.monitoring = true;
      this.output = concatBytes(
        this.output,
        asciiEncode(this.stream.map((line) => `${line}\r`).join("")),
      );
      return Promise.resolve();
    }
    this.output = concatBytes(this.output, this.core.feed(data));
    return Promise.resolve();
  }

  read(): Promise<Uint8Array> {
    if (this.output.length === 0) return Promise.reject(new TransportTimeout("quiet"));
    const data = this.output.slice(0, 7);
    this.output = this.output.slice(7);
    return Promise.resolve(data);
  }
}

/** The adapter a scenario's car describes. A car that lists adapters has no link. */
export function buildTransport(car: CarSpec): Transport {
  switch (car.kind) {
    case "silent":
    case "adapters":
      return new SilentTransport();
    case "refusing":
      return new RefusingTransport(car.message);
    case "simulated":
      return simulatedTransport(loadBuiltinProfile(car.profile));
    case "elm": {
      const responders: Record<number, UnitResponder> = {};
      for (const spec of car.units) responders[hexInt(spec.request)] = unitResponder(spec);
      const functional = car.functional;
      if (functional !== undefined) {
        responders[0x7df] = (request) =>
          (
            functional[
              request
                .reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "")
                .toUpperCase()
            ] ?? []
          ).map(([sender, reply]): [number, Uint8Array] => [hexInt(sender), fromHex(reply)]);
      }
      const options: FakeElmOptions = {
        unsupported: new Set(car.unsupported),
        ...(car.stn === undefined ? {} : { stnIdentity: car.stn }),
      };
      return adapterTransport(new FakeElmCore(responders, options));
    }
    case "kline": {
      const units: Record<number, KLineUnit> = {};
      for (const [address, table] of Object.entries(car.units)) {
        units[hexInt(address)] = (request) => {
          const key = Array.from(request, (byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
          const reply = table[key];
          return reply === undefined ? Uint8Array.of(0x7f, request[0] ?? 0, 0x11) : fromHex(reply);
        };
      }
      const core = new FakeKLineCore(units, new Set(car.silentInit.map(hexInt)));
      core.corrupt = car.corrupt;
      return new ScriptedTransport((written) => core.feed(written));
    }
    case "monitor":
      return new MonitoringAdapter(car.stream, car.stn);
    case "rawcan": {
      const link = new FakeCanLink({});
      for (const [canId, data] of car.inject) link.inject(hexInt(canId), fromHex(data));
      return new RawCanTransport(link);
    }
  }
}
