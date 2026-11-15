/**
 * The simulator as a {@link TransportHost}: a car that answers live values, for trying the service without hardware.
 *
 * `simulator://<profile>` names a fresh simulated car for that profile; `simulator://generic-obd2` names one with no control units beyond the engine unit that answers the legislated reads. Its engine unit answers the legislated reads {@link simulatedLiveCar} lists, with values that change on every read so a collection run stores a series and not one constant. Every reading is invented and describes no car.
 */

import { asciiEncode, concatBytes, fromHex, toUpperHex } from "./bytes.js";
import { GENERIC_PROFILE } from "./generic.js";
import { DiagProtocol } from "./guard.js";
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

/** The adapter URL of the simulator with no vehicle profile: a car that answers the legislated OBD-II reads and has no named units. */
export const GENERIC_SIMULATOR_URL = simulatorUrl(GENERIC_PROFILE);

/** Whether an adapter URL names the simulator. */
export function isSimulatorUrl(adapterUrl: string): boolean {
  return adapterUrl.startsWith(SIMULATOR_URL_PREFIX);
}

// Supported-identifier bitmap for mode 01: engine speed (0x0C), vehicle speed (0x0D) and coolant temperature (0x05). Bit 0x20 is clear, so the chain of bitmaps ends here.
const SUPPORTED = fromHex("41000818" + "0000");
// Mode 06 supports one monitor (identifier 01), and mode 09 the VIN (02) and the calibration identifier (04); the bit for the next bitmap is clear in each.
const SUPPORTED_MONITORS = fromHex("460080000000");
const SUPPORTED_INFORMATION = fromHex("490050000000");
const MONITOR_RESULT = fromHex("4601" + "800A" + "0123" + "0000" + "0FFF");
const CALIBRATION_ID = concatBytes(fromHex("490401"), asciiEncode("SIMCAL0001"), new Uint8Array(6));
const STORED_CODE = fromHex("43010420");
const NO_CODES = fromHex("4300");
const LAMP_ON_READINESS = fromHex("410181000000");
const LAMP_OFF_READINESS = fromHex("410100000000");
// The freeze frame stored with the one invented code, P0420: its code, coolant temperature and engine speed.
const FROZEN: ReadonlyMap<string, Uint8Array> = new Map([
  ["020200", fromHex("42020004" + "20")],
  ["020500", fromHex("420500" + "8C")],
  ["020C00", fromHex("420C00" + "0BB8")],
]);

/**
 * The legislated reads of a simulated engine unit: everything {@link obdResponder} answers, the supported-identifier bitmaps, three live values that vary on every read, a mode 06 result, the freeze frame of its one code and the calibration identifier.
 *
 * Mode 04 clears the one stored code, the warning lamp and the freeze frame, as a car does. Each call returns an independent responder with its own counter and its own code state.
 */
export function liveObdResponder(): UnitResponder {
  let ticks = 0;
  let stored = true;
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
    if (key === "0101") return [[0x7e8, stored ? LAMP_ON_READINESS : LAMP_OFF_READINESS]];
    if (key === "03") return [[0x7e8, stored ? STORED_CODE : NO_CODES]];
    if (key === "04") {
      stored = false;
      return [[0x7e8, Uint8Array.of(0x44)]];
    }
    if (key === "0A") return [[0x7e8, fromHex("4A00")]];
    if (key === "0600") return [[0x7e8, SUPPORTED_MONITORS]];
    if (key === "0601") return [[0x7e8, MONITOR_RESULT]];
    if (key === "0900") return [[0x7e8, SUPPORTED_INFORMATION]];
    if (key === "0904") return [[0x7e8, CALIBRATION_ID]];
    const frozen = FROZEN.get(key);
    if (frozen !== undefined) return stored ? [[0x7e8, frozen]] : [];
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
    const car =
      this.profileName === GENERIC_PROFILE
        ? simulatedLiveCar({ protocol: DiagProtocol.KWP2000, units: new Map() })
        : simulatedLiveCar(await this.loadProfile(this.profileName));
    this.inner = adapterTransport(car);
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
