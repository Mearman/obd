/**
 * Logs the adapter's own voltage reading at a fixed interval, for example through an engine start.
 *
 * The adapter measures the voltage at the diagnostic socket's battery pin, so this needs no
 * car-specific data and no bus. A weak supply explains many stored fault codes, and the dip while
 * cranking and the charging voltage afterwards show how healthy it is.
 */

import type { AdapterInfo, Elm } from "./elm.js";
import { ElmError } from "./elm.js";
import { formatSignificant, pythonListRepr } from "./format.js";
import { OptionError } from "./options.js";
import type { OpenCsvLog } from "./openlog.js";
import { isoNow, now, sleep } from "./time.js";
import type { LineSink } from "./unit-access.js";

/**
 * Adapter replies read like "12.4V" (ELM327 `ATRV`) and, on adapters with the STN extensions,
 * `STVR` gives the same with a chosen number of decimals.
 */
export const VOLTAGE = /(\d+(?:\.\d+)?)\s*V/i;

/**
 * Reads the supply voltage in volts.
 *
 * Uses `STVR` (with the precision, when given) on an adapter that has the STN extensions and the
 * standard `ATRV` otherwise.
 *
 * @throws ElmError when the reply holds no voltage.
 */
export async function readVoltage(
  elm: Elm,
  options: { readonly stn: boolean; readonly precision?: number },
): Promise<number> {
  const { stn, precision } = options;
  const command = !stn ? "ATRV" : precision === undefined ? "STVR" : `STVR ${String(precision)}`;
  const lines = await elm.command(command);
  for (const line of lines) {
    const found = VOLTAGE.exec(line);
    if (found?.[1] !== undefined) return Number.parseFloat(found[1]);
  }
  throw new ElmError(`no voltage in the reply to ${command}: ${pythonListRepr(lines)}`);
}

/** What the battery command was asked for. */
export interface BatteryOptions {
  /** How long to sample, in milliseconds; zero takes one sample. */
  readonly durationMs: number;
  /** The gap between samples, in milliseconds. */
  readonly intervalMs: number;
  /** Decimal places to ask an STN adapter for. */
  readonly precision?: number;
  /** Opens the CSV log the samples are also written to. */
  readonly openLog?: OpenCsvLog;
}

/**
 * Runs the battery command: samples the voltage for `durationMs` milliseconds, `intervalMs` apart.
 *
 * Prints each sample and a summary, and logs rows when `openLog` is given.
 *
 * @returns The exit status, always 0.
 * @throws OptionError for a bad duration, interval or precision.
 * @throws ElmError when a reply holds no voltage.
 */
export async function batteryCommand(
  elm: Elm,
  adapter: AdapterInfo,
  options: BatteryOptions,
  out: LineSink,
): Promise<number> {
  const { durationMs, intervalMs, precision, openLog } = options;
  if (durationMs < 0 || intervalMs <= 0) {
    throw new OptionError("--duration must not be negative and --interval must be positive");
  }
  if (precision !== undefined && precision < 0) {
    throw new OptionError("--precision must not be negative");
  }
  const stn = adapter.hasStnExtensions;
  out(
    `reading the voltage with ${stn ? "STVR" : "ATRV"} every ${formatSignificant(intervalMs / 1000, 6)} s`,
  );
  const log = await openLog?.(["time", "elapsed (s)", "voltage (V)"]);
  const start = now();
  const samples: [elapsed: number, volts: number][] = [];
  try {
    for (;;) {
      const volts = await readVoltage(elm, precision === undefined ? { stn } : { stn, precision });
      const elapsed = (now() - start) / 1000;
      samples.push([elapsed, volts]);
      out(`${elapsed.toFixed(2)} s: ${formatSignificant(volts, 6)} V`);
      await log?.write([isoNow(), elapsed.toFixed(3), formatSignificant(volts, 6)]);
      if (elapsed * 1000 + intervalMs > durationMs) break;
      await sleep(intervalMs);
    }
  } finally {
    await log?.close();
  }
  let lowest = samples[0];
  let highest = samples[0];
  for (const sample of samples) {
    if (lowest === undefined || sample[1] < lowest[1]) lowest = sample;
    if (highest === undefined || sample[1] > highest[1]) highest = sample;
  }
  const last = samples.at(-1);
  if (lowest === undefined || highest === undefined || last === undefined) {
    throw new RangeError("the battery command took no samples");
  }
  out(
    `${String(samples.length)} sample${samples.length === 1 ? "" : "s"}: ` +
      `lowest ${formatSignificant(lowest[1], 6)} V at ${lowest[0].toFixed(2)} s, ` +
      `highest ${formatSignificant(highest[1], 6)} V at ${highest[0].toFixed(2)} s, ` +
      `last ${formatSignificant(last[1], 6)} V`,
  );
  return 0;
}
