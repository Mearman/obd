/**
 * The parity scenarios: what the Python command line was recorded doing (see `test/golden/README.md`), and what the TypeScript command line is run against. `scenarios.json` lists the scenarios; the golden files hold what Python printed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The directory holding `scenarios.json` and the golden files. */
export const GOLDEN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "golden");

const hexText = z.string();

const unitSchema = z.object({
  protocol: z.enum(["kwp", "uds"]),
  request: hexText,
  response: hexText,
  faults: z.array(z.tuple([hexText, hexText])).default([]),
  freezeRefused: z.boolean().default(false),
  writesRefused: z.boolean().default(false),
  refuseAll: z.boolean().default(false),
  records: z.record(z.string(), hexText).default({}),
  values: z.record(z.string(), hexText).default({}),
});

/** One scripted unit on a scripted car. */
export type UnitSpec = z.output<typeof unitSchema>;

const carSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("silent") }),
  z.object({ kind: z.literal("refusing"), message: z.string() }),
  z.object({ kind: z.literal("simulated"), profile: z.string() }),
  z.object({
    kind: z.literal("elm"),
    units: z.array(unitSchema),
    functional: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))).optional(),
    unsupported: z.array(z.string()).default([]),
    stn: z.string().optional(),
  }),
  z.object({
    kind: z.literal("kline"),
    units: z.record(z.string(), z.record(z.string(), z.string())),
    silentInit: z.array(z.string()).default([]),
    corrupt: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("monitor"), stream: z.array(z.string()), stn: z.boolean() }),
  z.object({ kind: z.literal("rawcan"), inject: z.array(z.tuple([z.string(), z.string()])) }),
  z.object({
    kind: z.literal("adapters"),
    ble: z.array(z.object({ name: z.string().nullable(), address: z.string(), rssi: z.number() })),
    ports: z.array(z.object({ device: z.string(), description: z.string() })),
    services: z.array(
      z.object({
        service: z.string(),
        uuid: z.string(),
        properties: z.array(
          z.enum(["read", "write", "write-without-response", "notify", "indicate"]),
        ),
      }),
    ),
  }),
]);

/** A scripted car or adapter. */
export type CarSpec = z.output<typeof carSchema>;

const scenarioSchema = z.object({
  name: z.string(),
  car: z.string(),
  argv: z.array(z.string()),
  answer: z.string().default(""),
  files: z.record(z.string(), z.string()).default({}),
  profiles: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  brokerFailAfter: z.number().optional(),
  stopAfterLines: z.number().optional(),
});

/** One command line run against one scripted car. */
export type Scenario = z.output<typeof scenarioSchema>;

const scenarioFileSchema = z.object({
  cars: z.record(z.string(), carSchema),
  profiles: z.record(z.string(), z.unknown()),
  scenarios: z.array(scenarioSchema),
});

const brokerSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    host: z.string(),
    port: z.number(),
    clientId: z.string(),
    tls: z.boolean(),
    will: z.tuple([z.string(), z.string(), z.boolean()]),
    username: z.string().nullable(),
    password: z.string().nullable(),
    messages: z.array(z.tuple([z.string(), z.string(), z.boolean()])),
    closed: z.boolean(),
  }),
]);

/** What the broker was given. */
export type BrokerRecord = z.output<typeof brokerSchema>;

const goldenSchema = z.object({
  name: z.string(),
  exit: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  files: z.record(z.string(), z.string()),
  broker: brokerSchema.optional(),
});

/** What the Python command line did for one scenario. */
export type Golden = z.output<typeof goldenSchema>;

/** Every scenario, with the cars and profile sources they refer to. */
export function loadScenarios(): z.output<typeof scenarioFileSchema> {
  return scenarioFileSchema.parse(
    JSON.parse(readFileSync(join(GOLDEN_DIRECTORY, "scenarios.json"), "utf8")),
  );
}

/** The recorded Python behaviour of one scenario. */
export function loadGolden(name: string): Golden {
  return goldenSchema.parse(
    JSON.parse(readFileSync(join(GOLDEN_DIRECTORY, `${name}.golden.json`), "utf8")),
  );
}
