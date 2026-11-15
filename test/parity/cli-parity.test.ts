/**
 * Parity: the TypeScript command line against what the Python command line printed.
 *
 * Every scenario in `test/golden/scenarios.json` is run on the scripted adapter the goldens were recorded against, with the clock frozen as it was frozen there, and its standard output, standard error, exit status, written files and broker traffic must equal the golden record. The only rewriting is in `normalise.ts`.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrokerError, type Connect } from "../../src/core/mqtt.js";
import type { BleAdvertisement, BleCentral } from "../../src/node/ble.js";
import { run, type CliIo } from "../../src/node/cli.js";
import { buildTransport } from "./cars.js";
import { observedPython, observedTypeScript } from "./normalise.js";
import { loadGolden, loadScenarios, type BrokerRecord, type Scenario } from "./scenarios.js";

const FROZEN = new Date("2026-01-02T03:04:05.678Z");
const PROFILE_TOKEN = "@profile:";

const { cars, profiles, scenarios } = loadScenarios();

/** Every file under `directory`, by relative name, as text. */
async function filesUnder(directory: string, prefix = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(found, await filesUnder(join(directory, entry.name), `${relative}/`));
    } else {
      found[relative] = await readFile(join(directory, entry.name), "utf8");
    }
  }
  return found;
}

/** A broker that records what it was given, and fails like the Python fake does. */
function recordingBroker(failAfter: number | undefined): {
  readonly connect: Connect;
  readonly record: () => BrokerRecord;
} {
  const messages: [string, string, boolean][] = [];
  let settings: Parameters<Connect>[0] | undefined;
  let closed = false;
  return {
    connect: (given) => {
      settings = given;
      return Promise.resolve({
        publish: (topic, payload, options) => {
          if (failAfter !== undefined && messages.length >= failAfter) {
            return Promise.reject(new BrokerError("connection lost"));
          }
          messages.push([topic, payload, options.retain]);
          return Promise.resolve();
        },
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      });
    },
    record: () =>
      settings === undefined
        ? { connected: false }
        : {
            connected: true,
            host: settings.host,
            port: settings.port,
            clientId: settings.clientId,
            tls: settings.tls,
            will: [settings.will.topic, settings.will.payload, settings.will.retain],
            username: settings.username ?? null,
            password: settings.password ?? null,
            messages,
            closed,
          },
  };
}

/** The radio and serial ports a scenario's car lists. */
function scriptedRadio(car: (typeof cars)[string]): Pick<CliIo, "central" | "listPorts"> {
  if (car.kind !== "adapters") {
    return {
      central: () => {
        throw new Error("a scenario reached for the Bluetooth radio");
      },
      listPorts: () => Promise.reject(new Error("a scenario reached for the serial ports")),
    };
  }
  const advertisements: BleAdvertisement[] = car.ble.map((device) => ({
    id: device.address,
    address: device.address,
    name: device.name ?? undefined,
    rssi: device.rssi,
  }));
  const central: BleCentral = {
    scan: () => Promise.resolve(advertisements),
    close: () => undefined,
    peripheral: () => ({
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      characteristics: () => Promise.resolve(car.services),
      subscribe: () => Promise.resolve(),
      write: () => Promise.resolve(),
      onDisconnect: () => undefined,
    }),
  };
  return {
    central: () => central,
    listPorts: () =>
      Promise.resolve(
        car.ports.map((port) => ({ path: port.device, description: port.description })),
      ),
  };
}

/** Runs one scenario and returns what the command line did. */
async function runScenario(scenario: Scenario): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: Record<string, string>;
  readonly broker: BrokerRecord;
}> {
  const car = cars[scenario.car];
  if (car === undefined) throw new Error(`scenario ${scenario.name} names no car`);
  const directory = await mkdtemp(join(tmpdir(), "obd-read-parity-"));
  try {
    const initial: Record<string, string> = {};
    for (const name of scenario.profiles) {
      initial[`${name}.json`] = `${JSON.stringify(profiles[name], null, 2)}\n`;
    }
    for (const [name, text] of Object.entries(scenario.files)) {
      initial[name.endsWith(".toml") ? `${name.slice(0, -5)}.json` : name] = text;
    }
    for (const [name, text] of Object.entries(initial))
      await writeFile(join(directory, name), text);

    const lines: string[] = [];
    let stderr = "";
    const controller = new AbortController();
    const broker = recordingBroker(scenario.brokerFailAfter);
    const io: CliIo = {
      out: (line) => {
        lines.push(line);
        if (scenario.stopAfterLines !== undefined && lines.length >= scenario.stopAfterLines) {
          controller.abort();
        }
      },
      err: (text) => {
        stderr += text;
      },
      ask: () => Promise.resolve(scenario.answer),
      open: () => buildTransport(car),
      env: scenario.env,
      directory,
      connect: broker.connect,
      ...scriptedRadio(car),
      signal: controller.signal,
    };
    const argv = scenario.argv.map((word) =>
      word.startsWith(PROFILE_TOKEN) ? `${word.slice(PROFILE_TOKEN.length)}.json` : word,
    );
    const exit = await run(argv, io);
    const written: Record<string, string> = {};
    for (const [name, text] of Object.entries(await filesUnder(directory))) {
      if (initial[name] !== text) written[name] = text;
    }
    return {
      exit,
      stdout: lines.map((line) => `${line}\n`).join(""),
      stderr,
      files: written,
      broker: broker.record(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("the command line matches the Python command line", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("covers every golden file and no other", async () => {
    const recorded = (await readdir(join(import.meta.dirname, "..", "golden")))
      .filter((name) => name.endsWith(".golden.json"))
      .map((name) => name.replace(".golden.json", ""))
      .sort();
    expect(recorded).toEqual(scenarios.map((scenario) => scenario.name).sort());
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_name, scenario) => {
      const golden = loadGolden(scenario.name);
      const actual = await runScenario(scenario);
      const names = [
        ...scenario.profiles,
        ...scenario.argv
          .filter((word) => word.startsWith(PROFILE_TOKEN))
          .map((word) => word.slice(PROFILE_TOKEN.length)),
      ];
      expect(observedTypeScript(actual, names)).toEqual(observedPython(golden));
      if (golden.broker !== undefined) expect(actual.broker).toEqual(golden.broker);
    },
  );
});
