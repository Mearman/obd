import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { LIVE_SUBSCRIBER_BUFFER, type Sample } from "../src/core/index.js";
import { connectDiagnostics, serveDiagnostics } from "../src/node/index.js";
import { describeServiceContract } from "./support/service-contract.js";
import { newHost } from "./support/service-fixtures.js";

describeServiceContract("message-port", ({ host }) => {
  const { port1, port2 } = new MessageChannel();
  serveDiagnostics(host, port1);
  const client = connectDiagnostics(port2);
  return {
    client,
    dispose: () => {
      port1.close();
      port2.close();
    },
  };
});

describe("live samples over a message port", () => {
  it("ends a subscriber that falls too far behind, with an error and not silent loss", async () => {
    const { host, collector } = newHost();
    const run = await host.client.runs.start({ profile: "p", adapter: "ble://x" });
    const live = await host.client.live.samples({ runId: run.id });
    const first = live.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const batch: Sample[] = Array.from({ length: LIVE_SUBSCRIBER_BUFFER + 5 }, (_, index) => ({
      runId: run.id,
      signal: "n",
      unit: "",
      timestamp: index,
      value: index,
    }));
    await collector.sink?.write(batch);
    expect((await first).value).toEqual(batch[0]);
    let received = 1;
    await expect(
      (async () => {
        for (;;) {
          const step = await live.next();
          if (step.done === true) return;
          received += 1;
        }
      })(),
    ).rejects.toThrow(/fell more than/);
    expect(received).toBe(LIVE_SUBSCRIBER_BUFFER);
  });
});
