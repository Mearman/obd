/**
 * The simulator as a {@link TransportHost}: a car that answers live values, for trying the service without hardware.
 *
 * `simulator://<profile>` names a fresh simulated car for that profile. Its engine unit answers the legislated reads {@link simulatedLiveCar} lists, with values that change on every read so a collection run stores a series and not one constant. Every reading is invented and describes no car.
 */

import { fromHex, toUpperHex } from "./bytes.js";
import type { Profile } from "./profile.js";
import {
  FUNCTIONAL_REQUEST_ID,
  adapterTransport,
  obdResponder,
  simulatedCar,
  type FakeElmCore,
  type UnitResponder,
} from "./simulator.js";
import type { TransportHost } from "./transport-host.js";
import { TransportError, type Transport } from "./transport.js";

/** What a simulated adapter URL starts with; the rest names the profile. */
export const SIMULATOR_URL_PREFIX = "simulator://";

/** The adapter URL of the simulator for a profile. */
export function simulatorUrl(profile: string): string {
  return `${SIMULATOR_URL_PREFIX}${profile}`;
}

/** Whether an adapter URL names the simulator. */
export function isSimulatorUrl(adapterUrl: string): boolean {
  return adapterUrl.startsWith(SIMULATOR_URL_PREFIX);
}

// Supported-identifier bitmap for mode 01: engine speed (0x0C), vehicle speed (0x0D) and coolant temperature (0x05). Bit 0x20 is clear, so the chain of bitmaps ends here.
const SUPPORTED = fromHex("41000818" + "0000");

/**
 * The legislated reads of a simulated engine unit: everything {@link obdResponder} answers, the supported-identifier bitmap and three live values that vary on every read.
 *
 * Each call returns an independent responder with its own counter.
 */
export function liveObdResponder(): UnitResponder {
  let ticks = 0;
  return (request) => {
    const key = toUpperHex(request);
    if (key === "0100") return [[0x7e8, SUPPORTED]];
    if (key === "0105") return [[0x7e8, Uint8Array.of(0x41, 0x05, 128 + (ticks % 8))]];
    if (key === "010C") {
      ticks += 1;
      const quarterRpm = (780 + (ticks % 40) * 4) * 4;
      return [[0x7e8, Uint8Array.of(0x41, 0x0c, quarterRpm >> 8, quarterRpm & 0xff)]];
    }
    if (key === "010D") return [[0x7e8, Uint8Array.of(0x41, 0x0d, ticks % 60)]];
    return obdResponder(request);
  };
}

/** A fresh {@link simulatedCar} whose functional address also answers live values. */
export function simulatedLiveCar(profile: Pick<Profile, "protocol" | "units">): FakeElmCore {
  const car = simulatedCar(profile);
  car.responders[FUNCTIONAL_REQUEST_ID] = liveObdResponder();
  return car;
}

/** A transport that builds its simulated car when opened, once the profile it names is loaded. */
class SimulatedTransport implements Transport {
  private inner: Transport | undefined;

  constructor(
    private readonly profileName: string,
    private readonly loadProfile: (name: string) => Promise<Profile>,
  ) {}

  async open(): Promise<void> {
    this.inner = adapterTransport(simulatedLiveCar(await this.loadProfile(this.profileName)));
    await this.inner.open();
  }

  async close(): Promise<void> {
    await this.inner?.close();
    this.inner = undefined;
  }

  write(data: Uint8Array): Promise<void> {
    return this.opened().write(data);
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    return this.opened().read(timeoutMs);
  }

  private opened(): Transport {
    if (this.inner === undefined) throw new TransportError("the simulated adapter is not open");
    return this.inner;
  }
}

/**
 * A host that serves {@link SIMULATOR_URL_PREFIX} URLs. Each opened transport is a fresh simulated car of the named profile.
 *
 * @param loadProfile Finds the profile by name; rejects when there is none.
 */
export function simulatorTransportHost(
  loadProfile: (name: string) => Promise<Profile>,
): TransportHost {
  return {
    schemes: () => [],
    serves: isSimulatorUrl,
    create: (adapterUrl) => {
      if (!isSimulatorUrl(adapterUrl)) {
        throw new TransportError(`${JSON.stringify(adapterUrl)} is not a simulator URL`);
      }
      return new SimulatedTransport(adapterUrl.slice(SIMULATOR_URL_PREFIX.length), loadProfile);
    },
  };
}
