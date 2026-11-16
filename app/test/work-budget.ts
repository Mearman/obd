/**
 * Limits on a test measured in the work it does rather than in elapsed time.
 *
 * A component test renders the app in jsdom inside one worker process, so its elapsed time is its work divided by the share of a processor the machine gives that worker: on a busy machine a correct test takes many times longer, and any limit in elapsed time fails it. These limits instead count the processor time the worker uses, which a busy machine does not change, and the samples in a row in which the worker did nothing, which catches a test waiting on something that will never happen without charging it for time spent waiting its turn on a processor.
 */

/** The limits one test runs under. */
export interface WorkBudget {
  /** The processor time, in milliseconds, the worker may use while the test runs. */
  readonly processorMs: number;
  /** How often, in milliseconds of elapsed time, the worker's processor time is sampled. */
  readonly sampleMs: number;
  /** The samples in a row the worker may stay idle before the test is failed as stalled. */
  readonly idleSamples: number;
  /** The processor time, in milliseconds, below which the worker counts as idle between two samples. It is absolute rather than a share of the elapsed time because a worker kept off the processor by a busy machine still uses a whole scheduling slice each time it runs, whereas an idle one uses only what taking the sample costs. */
  readonly idleProcessorMs: number;
}

// Taken when the setup file loads, before any test can install fake timers, so the sampling keeps to real time whatever the test does with the clock.
const { setInterval, clearInterval } = globalThis;

/** Processor time used by this process since `since`, in milliseconds. */
function processorMsSince(since: NodeJS.CpuUsage): number {
  const used = process.cpuUsage(since);
  return (used.user + used.system) / 1000;
}

/**
 * Runs `test` and settles as it does, unless it first uses more processor time than `budget` allows or stays idle for more samples in a row than it allows.
 *
 * The worker's processor time includes anything else running in it, so this must wrap one test at a time in a process of its own, as Vitest's `forks` pool runs them.
 *
 * @param describe - What the test was looking at, added to the error when a limit is reached.
 * @throws an `Error` naming the limit reached and the work done when either limit is reached; the test itself is not stopped and its own errors are not reported after that.
 */
export async function withinBudget(
  test: () => Promise<void>,
  budget: WorkBudget,
  describe: () => string,
): Promise<void> {
  const started = process.cpuUsage();
  let sampled = process.cpuUsage();
  let idle = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const exceeded = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const used = processorMsSince(sampled);
      idle = used < budget.idleProcessorMs ? idle + 1 : 0;
      sampled = process.cpuUsage();
      const total = processorMsSince(started);
      if (total > budget.processorMs) {
        reject(
          new Error(
            `The test used more than its ${String(budget.processorMs)} ms of processor time (${total.toFixed(0)} ms).\n${describe()}`,
          ),
        );
      } else if (idle > budget.idleSamples) {
        reject(
          new Error(
            `The test did no work for ${String(idle)} samples in a row of ${String(budget.sampleMs)} ms, so it is waiting on something that will not happen (${total.toFixed(0)} ms of processor time used).\n${describe()}`,
          ),
        );
      }
    }, budget.sampleMs);
  });
  try {
    await Promise.race([test(), exceeded]);
  } finally {
    clearInterval(timer);
  }
}
