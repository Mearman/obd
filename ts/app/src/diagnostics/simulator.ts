import {
  DiagnosticsError,
  type ConnectionInfo,
  type ConnectRequest,
  type DiagnosticsClient,
  type LiveFrame,
  type LiveValue,
  type RunSummary,
  type ScanResult,
} from "./client";

/** The fixed values every simulated live frame carries. They are invented, not from a car. */
export const SIMULATED_VALUES: readonly LiveValue[] = [
  { name: "rpm", label: "Engine speed", value: 780, unit: "rpm" },
  { name: "coolant", label: "Coolant temperature", value: 88, unit: "°C" },
  { name: "battery", label: "Battery voltage", value: 12.6, unit: "V" },
  { name: "intake", label: "Intake air temperature", value: 21, unit: "°C" },
  { name: "load", label: "Engine load", value: 24, unit: "%" },
];

/** The fixed runs the simulator lists. */
export const SIMULATED_RUNS: readonly RunSummary[] = [
  {
    id: "sim-2",
    profile: "mercedes-w211",
    startedAt: "2026-01-02T10:15:00Z",
    samples: 1800,
    simulated: true,
  },
  {
    id: "sim-1",
    profile: "mercedes-w211",
    startedAt: "2026-01-01T09:00:00Z",
    samples: 600,
    simulated: true,
  },
];

const FRAME_INTERVAL_MS = 1000;

/** Waits `ms` or until `signal` aborts, whichever is first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

/**
 * A {@link DiagnosticsClient} that returns fixed fake data and never touches hardware.
 *
 * Only the `simulator` adapter connects. The hardware adapters reject with a
 * {@link DiagnosticsError}, because this build has no service behind them yet.
 */
export function createSimulatorClient(): DiagnosticsClient {
  let connected = false;

  function requireConnection(): void {
    if (!connected) throw new DiagnosticsError("Connect an adapter first.");
  }

  return {
    connect(request: ConnectRequest): Promise<ConnectionInfo> {
      if (request.kind !== "simulator") {
        return Promise.reject(
          new DiagnosticsError(
            "This build cannot reach a real adapter yet. Choose the simulator to try the app.",
          ),
        );
      }
      connected = true;
      return Promise.resolve({ adapter: "Simulator", simulated: true });
    },

    disconnect(): Promise<void> {
      connected = false;
      return Promise.resolve();
    },

    scan(profile: string): Promise<ScanResult> {
      requireConnection();
      return Promise.resolve({
        profile,
        simulated: true,
        units: [
          { unit: "engine", description: "Engine control", faultCount: 1, responded: true },
          { unit: "transmission", description: "Transmission", faultCount: 0, responded: true },
          { unit: "abs", description: "Anti-lock brakes", faultCount: 0, responded: true },
          { unit: "airbag", description: "Airbags", faultCount: 0, responded: false },
        ],
      });
    },

    async *liveValues(signal: AbortSignal): AsyncGenerator<LiveFrame> {
      requireConnection();
      for (let sequence = 1; !signal.aborted; sequence += 1) {
        yield { sequence, values: SIMULATED_VALUES };
        await pause(FRAME_INTERVAL_MS, signal);
      }
    },

    runs(): Promise<readonly RunSummary[]> {
      return Promise.resolve(SIMULATED_RUNS);
    },
  };
}
