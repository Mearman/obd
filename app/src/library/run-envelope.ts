import { runShareEnvelope, type Run, type Sample, type ShareEnvelope } from "obd-read";
import type { DiagnosticsClient } from "../diagnostics/client";

/** How many samples one read of a run's samples asks for. */
const PAGE = 5000;

/** The envelope that shares `run`, dated by the run itself so the same run always makes the same link, read from the service when the user asks to share: a plan result for a run that recorded its plan, else a run summary of its aggregates and a thinned series. */
export async function runEnvelope(client: DiagnosticsClient, run: Run): Promise<ShareEnvelope> {
  const aggregates = await client.runs.aggregate({ runId: run.id });
  const samples: Sample[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.runs.samples({ runId: run.id, limit: PAGE, offset });
    samples.push(...page);
    if (page.length < PAGE) break;
  }
  // A run that recorded its plan shares as a plan result, with its phases, codes and the plan itself.
  return runShareEnvelope(run, samples, run.startedAt, aggregates);
}
