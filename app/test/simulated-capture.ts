import {
  CaptureRecorder,
  Elm,
  FUNCTIONAL_ID,
  adapterTransport,
  buildCapture,
  captureAdapter,
  captureShareData,
  encodeShare,
  obdReport,
  scan,
  selectBus,
  simulatedCar,
  type Capture,
  type ShareEnvelope,
} from "obd-read";
import { loadBuiltinProfile } from "obd-read/profiles";
import { streamShareCodec } from "obd-read/web";

/** When the simulated capture was made. */
export const CAPTURED_AT = Date.UTC(2026, 10, 15, 10, 0, 0);

/** A capture of the simulated W211: every unit scanned with fault codes, then the legislated OBD-II reads. Every byte is invented. */
export async function simulatedCapture(): Promise<Capture> {
  const profile = loadBuiltinProfile("mercedes-w211");
  const elm = new Elm(adapterTransport(simulatedCar(profile)));
  const adapter = await elm.initialise();
  await selectBus(elm, profile);
  const recorder = new CaptureRecorder(elm, { now: () => CAPTURED_AT });
  recorder.start();
  await scan(elm, profile, { faults: true, freeze: false });
  await elm.addressFunctional(FUNCTIONAL_ID[11]);
  await obdReport(elm, () => undefined);
  recorder.stop();
  return buildCapture(
    {
      id: "capture-shared-test",
      startedAt: CAPTURED_AT,
      endedAt: CAPTURED_AT,
      origin: {
        kind: "capture",
        profile: profile.name,
        complete: true,
        description: "everything the car offers",
      },
      session: {
        adapter: captureAdapter(adapter, "simulator://mercedes-w211"),
        tool: { name: "obd-read", version: "test" },
      },
    },
    recorder.exchanges,
  );
}

/** The fragment of a link that shares `capture`, as the app's Share dialog makes it. */
export async function captureFragment(capture: Capture, redactVin = false): Promise<string> {
  const data = captureShareData(capture);
  if (!data.ok) throw new Error(data.error.message);
  const envelope: ShareEnvelope = {
    v: 1,
    kind: "capture",
    createdAt: Date.UTC(2026, 10, 15, 11, 0, 0),
    data: data.value,
  };
  const result = await encodeShare(envelope, streamShareCodec, { redactVin });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.fragment;
}
