import { runSummaryShareData, type Run, type Sample, type ShareEnvelope } from "obd-read";
import type { DiagnosticsClient } from "../diagnostics/client";

/** How many samples one read of a run's samples asks for. */
const PAGE = 5000;

/** The envelope that shares `run`: its aggregates and a thinned series, read from the service when the user asks to share. */
export async function runEnvelope(client: DiagnosticsClient, run: Run): Promise<ShareEnvelope> {
  const aggregates = await client.runs.aggregate({ runId: run.id });
  const samples: Sample[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.runs.samples({ runId: run.id, limit: PAGE, offset });
    samples.push(...page);
    if (page.length < PAGE) break;
  }
  return {
    v: 1,
    kind: "run-summary",
    createdAt: Date.now(),
    data: runSummaryShareData(run, aggregates, samples),
  };
}
