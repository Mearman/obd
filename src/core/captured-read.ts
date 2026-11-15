/**
 * How a live command reads through a capture: the read is recorded, then run again over what was recorded, and the second run's result is what the command reports.
 *
 * This keeps one path from raw bytes to a report. The live commands (`scan`, `probe`, the unit reads, `obd`, the service's scan) and `decodeCapture` all decode exchanges through a {@link ReplayElm}, so what a command prints is exactly what its own capture decodes to later. This module is platform-free.
 */

import { CaptureRecorder } from "./capture.js";
import type { Elm, LinkState } from "./elm.js";
import type { Exchange } from "./exchange.js";
import { ReplayElm } from "./replay.js";
import type { LineSink } from "./unit-access.js";

/** A live read, the exchanges it sent and what decoding them gives. */
export interface CapturedRead<T> {
  /** What the read returns when it is run over its own exchanges. */
  readonly result: T;
  readonly exchanges: readonly Exchange[];
  /** The bus and addressing the session was in when the read began. */
  readonly initialState: LinkState;
}

/**
 * Runs `read` on the live session while recording its exchanges, then runs it again over those exchanges and returns that second result.
 *
 * `read` is given the session and a sink for its output: the live run's sink discards, the decoding run's is `out`. When the live run fails, the decoding run replays what was captured and stops where the live run did, so `out` gets exactly the lines the live run would have printed, and the live error is thrown.
 *
 * @param now The clock for the exchanges' times; defaults to `Date.now`.
 */
export async function readThroughCapture<T>(
  elm: Elm,
  read: (session: Elm, out: LineSink) => Promise<T>,
  out: LineSink = () => undefined,
  now?: () => number,
): Promise<CapturedRead<T>> {
  const recorder = new CaptureRecorder(elm, now === undefined ? {} : { now });
  recorder.start();
  let failure: { readonly error: unknown } | undefined;
  try {
    await read(elm, () => undefined);
  } catch (error) {
    failure = { error };
  } finally {
    recorder.stop();
  }
  if (failure !== undefined) {
    try {
      await read(new ReplayElm(recorder.exchanges, recorder.initialState, true), out);
    } catch {
      // The replay stops where the capture does; the live read's own error is the one reported.
    }
    throw failure.error;
  }
  return {
    result: await read(new ReplayElm(recorder.exchanges, recorder.initialState), out),
    exchanges: recorder.exchanges,
    initialState: recorder.initialState,
  };
}
