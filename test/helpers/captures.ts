/** Captures recorded from the scripted car, for the capture and decode tests. Every byte is invented. */

import {
  CaptureRecorder,
  Elm,
  adapterTransport,
  buildCapture,
  captureAdapter,
  parseProfile,
  selectBus,
  simulatedCar,
  type Capture,
  type CaptureOrigin,
  type FakeElmCore,
  type Profile,
} from "../../src/core/index.js";
import { builtinProfileData } from "../../src/profiles/index.js";

/** A shipped profile by name. */
export function shipped(name: string): Profile {
  return parseProfile(builtinProfileData(name), name);
}

/** A profile from JSON written in a test. */
export function authored(document: unknown): Profile {
  return parseProfile(document, "test profile");
}

/** The fixed time every recorded exchange carries, so captures compare equal. */
export const RECORDED_AT = 1_763_200_000_000;

/** An initialised session on a fresh simulated car for `profile`, on its bus. */
export async function simulatedSession(
  profile: Profile,
  car: FakeElmCore = simulatedCar(profile),
): Promise<{
  readonly elm: Elm;
  readonly car: FakeElmCore;
  readonly adapter: Awaited<ReturnType<Elm["initialise"]>>;
}> {
  const elm = new Elm(adapterTransport(car));
  const adapter = await elm.initialise();
  await selectBus(elm, profile);
  return { elm, car, adapter };
}

/**
 * Records what `work` sends on a session to a simulated car for `profile` and returns it as a capture.
 */
export async function record(
  profile: Profile,
  work: (elm: Elm) => Promise<unknown>,
  origin: Partial<CaptureOrigin> = {},
  car?: FakeElmCore,
): Promise<Capture> {
  const { elm, adapter } = await simulatedSession(profile, car);
  const recorder = new CaptureRecorder(elm, { now: () => RECORDED_AT });
  recorder.start();
  await work(elm);
  recorder.stop();
  return buildCapture(
    {
      id: "capture-test",
      startedAt: RECORDED_AT,
      endedAt: RECORDED_AT,
      origin: {
        kind: "capture",
        profile: profile.name,
        complete: true,
        description: "recorded in a test",
        ...origin,
      },
      session: {
        adapter: captureAdapter(adapter, "simulator://test"),
        tool: { name: "obd-read", version: "test" },
      },
    },
    recorder.exchanges,
  );
}
