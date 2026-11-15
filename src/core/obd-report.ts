/** The `obd` command's report: everything the legislated reads say about a car, as printed lines. */

import { hexNumber } from "./bytes.js";
import { ElmError, type Elm } from "./elm.js";
import { KLineElm } from "./kline.js";
import { report } from "./legislated.js";
import { readAddressedObdScan, type ObdScan } from "./obd-scan.js";
import {
  FUNCTIONAL_ID,
  MISFIRE_FIRST_CYLINDER,
  MISFIRE_GENERAL,
  PENDING_CODES,
  PERMANENT_CODES,
  STORED_CODES,
  codes,
  freezeFrame,
  misfireCounts,
  readiness,
  vin,
} from "./obd.js";
import { DEFAULT_TESTER, KLINE_SCHEMES, type KLineScheme } from "./profile.js";
import type { LineSink } from "./unit-access.js";

/**
 * Prints the VIN, each unit's lamp state, the stored, pending and permanent codes, the supported
 * values, monitor results, calibration identifiers, freeze frames and misfire counts.
 *
 * The session must already be on the bus and addressed to every emissions unit
 * (`addressFunctional`). Every request goes through the guard.
 *
 * @returns The exit status, always 0.
 */
export async function obdReport(elm: Elm, out: LineSink): Promise<number> {
  out(`VIN: ${(await vin(elm)) ?? "not reported"}`);
  const states = await readiness(elm);
  if (states.size === 0) out("no unit answered the readiness request");
  for (const [sender, state] of states) {
    const lamp = state.lampOn ? "on" : "off";
    out(
      `unit ${hexNumber(sender, 1)}: warning lamp ${lamp}, ${String(state.codeCount)} stored codes`,
    );
  }
  const kinds: readonly (readonly [string, number])[] = [
    ["stored", STORED_CODES],
    ["pending", PENDING_CODES],
    ["permanent", PERMANENT_CODES],
  ];
  for (const [label, mode] of kinds) {
    let found: Map<number, string[]>;
    try {
      found = await codes(elm, mode);
    } catch (error) {
      if (!(error instanceof ElmError)) throw error;
      out(`${label} codes: not read (${error.message})`);
      continue;
    }
    for (const [sender, list] of found) {
      out(`${label} codes from ${hexNumber(sender, 1)}: ${list.join(", ") || "none"}`);
    }
  }
  await report(elm, out);
  for (const [sender, frame] of await freezeFrame(elm)) {
    out(`freeze frame from ${hexNumber(sender, 1)}: ${frame.code ?? "no code"}`);
    for (const [name, value] of frame.values) out(`  ${name}: ${value}`);
  }
  for (const [sender, monitors] of await misfireCounts(elm)) {
    out(
      `misfire counts from ${hexNumber(sender, 1)} ` +
        "(cylinder order follows the monitor order and is unconfirmed):",
    );
    for (const counts of monitors) {
      const where =
        counts.monitor === MISFIRE_GENERAL
          ? "engine"
          : `cylinder ${String(counts.monitor - MISFIRE_FIRST_CYLINDER + 1)}`;
      const average = counts.averageLastTenCycles ?? "not reported";
      const latest = counts.lastCycle ?? "not reported";
      out(
        `  ${where}: last cycle ${String(latest)}, average of last ten cycles ${String(average)}`,
      );
    }
  }
  return 0;
}

/** What the `obd` command is asked for: the CAN bus, or a K-line scheme instead of CAN. */
export interface ObdCommandOptions {
  /** The CAN identifier width, 11 or 29 bits. */
  readonly idBits: 11 | 29;
  /** The CAN bit rate in bit/s. */
  readonly bitrate: number;
  /** Read over K-line with this initialisation instead of CAN; needs a {@link KLineElm} session. */
  readonly kline?: KLineScheme;
}

/**
 * Selects the bus the `obd` command is asked for and addresses every emissions unit on it.
 *
 * @throws ElmError when a K-line scheme is asked for on a session that is not a {@link KLineElm}.
 */
export async function selectObdBus(elm: Elm, options: ObdCommandOptions): Promise<void> {
  if (options.kline !== undefined) {
    if (!(elm instanceof KLineElm)) {
      throw new ElmError("a K-line read needs a K-line adapter session");
    }
    await elm.selectKline({
      kind: "kline",
      scheme: options.kline,
      tester: DEFAULT_TESTER,
      headerFormat: KLINE_SCHEMES[options.kline].headerFormat,
    });
    await elm.addressFunctional();
  } else {
    await elm.selectCan(options.idBits, options.bitrate);
    await elm.addressFunctional(FUNCTIONAL_ID[options.idBits]);
  }
}

/**
 * The `obd` command: selects the bus, addresses every emissions unit and prints {@link obdReport}.
 * It needs no profile.
 *
 * @returns The exit status, always 0.
 * @throws ElmError when a K-line scheme is asked for on a session that is not a {@link KLineElm}.
 */
export async function obdCommand(
  elm: Elm,
  options: ObdCommandOptions,
  out: LineSink,
): Promise<number> {
  await selectObdBus(elm, options);
  return obdReport(elm, out);
}

/**
 * The `obd` command's structured form: selects the bus, addresses every emissions unit and reads the legislated services as an {@link ObdScan}, which a link or a saved file carries. It needs no profile.
 *
 * @throws ElmError when a K-line scheme is asked for on a session that is not a {@link KLineElm}, and as {@link readAddressedObdScan} does.
 */
export async function obdScanCommand(elm: Elm, options: ObdCommandOptions): Promise<ObdScan> {
  await selectObdBus(elm, options);
  return readAddressedObdScan(elm);
}
