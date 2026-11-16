import { describe, expect, it } from "vitest";
import {
  DiagProtocol,
  Elm,
  GENERIC_SIMULATOR_URL,
  MemoryStorage,
  PlanRunner,
  adapterTransport,
  fromHex,
  liveObdResponder,
  parsePlan,
  parseSimulatorUrl,
  simulatedLiveCar,
  simulatorUrl,
  toUpperHex,
  type PlanEvent,
} from "../src/core/index.js";
import { FakeClock } from "./helpers/fake-clock.js";

const PENDING = fromHex("07");

/** The pending-code answers of `count` successive reads from a responder. */
function pendingReads(respond: ReturnType<typeof liveObdResponder>, count: number): string[] {
  return Array.from({ length: count }, () =>
    respond(PENDING)
      .map(([, reply]) => toUpperHex(reply))
      .join(" "),
  );
}

describe("the live simulator's pending code", () => {
  it("holds no pending code by default", () => {
    expect(pendingReads(liveObdResponder(), 5)).toEqual(Array(5).fill("4700"));
  });

  it("reports P0300 pending on the reads its window names and none outside it", () => {
    const respond = liveObdResponder({ pendingCode: { firstRead: 2, lastRead: 3 } });
    expect(pendingReads(respond, 5)).toEqual(["4700", "47010300", "47010300", "4700", "4700"]);
  });

  it("is cleared by mode 04 with the stored code", () => {
    const respond = liveObdResponder({ pendingCode: { firstRead: 1, lastRead: 10 } });
    expect(pendingReads(respond, 1)).toEqual(["47010300"]);
    respond(fromHex("04"));
    expect(pendingReads(respond, 2)).toEqual(["4700", "4700"]);
  });

  it("leaves the stored code and the other reads as they are", () => {
    const plain = liveObdResponder();
    const scheduled = liveObdResponder({ pendingCode: { firstRead: 1, lastRead: 1 } });
    for (const request of ["03", "0101", "0200", "0902", "0A"]) {
      expect(scheduled(fromHex(request))).toEqual(plain(fromHex(request)));
    }
  });
});

describe("simulator URLs", () => {
  it("name only the profile when no option is given", () => {
    expect(simulatorUrl("generic-obd2")).toBe(GENERIC_SIMULATOR_URL);
    expect(parseSimulatorUrl(GENERIC_SIMULATOR_URL)).toEqual({ profile: "generic-obd2" });
  });

  it("carry the pending code window and read it back", () => {
    const url = simulatorUrl("mercedes-w211", { pendingCode: { firstRead: 2, lastRead: 4 } });
    expect(url).toBe("simulator://mercedes-w211?pending-code=2-4");
    expect(parseSimulatorUrl(url)).toEqual({
      profile: "mercedes-w211",
      pendingCode: { firstRead: 2, lastRead: 4 },
    });
  });

  it.each([
    "simulator://generic-obd2?pending-code=",
    "simulator://generic-obd2?pending-code=2",
    "simulator://generic-obd2?pending-code=0-2",
    "simulator://generic-obd2?pending-code=3-2",
    "simulator://generic-obd2?pending-code=a-b",
    "simulator://generic-obd2?pending-code=1.5-2",
    "simulator://generic-obd2?other=1",
    "simulator://?pending-code=1-2",
  ])("reject %s", (url) => {
    expect(() => parseSimulatorUrl(url)).toThrow();
  });
});

describe("a plan on a simulator whose pending code comes and goes", () => {
  // Each wait reads the lists once as its baseline: read 1 is the first phase's, read 2 shows the code, read 3 is the second phase's baseline and read 4 finds it gone.
  it("sees the code appear and then clear", async () => {
    const car = simulatedLiveCar(
      { protocol: DiagProtocol.KWP2000, units: new Map() },
      { pendingCode: { firstRead: 2, lastRead: 3 } },
    );
    const transport = adapterTransport(car);
    await transport.open();
    const elm = new Elm(transport);
    await elm.initialise();
    const plan = parsePlan(
      {
        format: "obd-read-plan",
        version: 1,
        name: "codes",
        title: "Codes",
        description: "A test.",
        source: "A test.",
        needs: { values: ["engine-speed"] },
        phases: [
          {
            id: "appear",
            title: "Appear",
            instruction: "Wait.",
            end: { when: { kind: "code-appears", list: "pending" }, timeout: 60 },
          },
          {
            id: "clear",
            title: "Clear",
            instruction: "Wait.",
            end: { when: { kind: "code-clears", list: "pending" }, timeout: 60 },
          },
        ],
      },
      "test",
    );
    const events: PlanEvent[] = [];
    const result = await new PlanRunner({
      plan,
      link: { withSession: (work) => work({ elm }) },
      storage: new MemoryStorage(),
      adapter: simulatorUrl("generic-obd2", { pendingCode: { firstRead: 2, lastRead: 3 } }),
      clock: new FakeClock(),
      codesIntervalMs: 0,
      onEvent: (event) => events.push(event),
    }).run();
    expect(result.outcome).toBe("completed");
    expect(
      events.flatMap((event) =>
        event.type === "code-appeared" || event.type === "code-cleared"
          ? [`${event.phase} ${event.type} ${event.list} ${event.code}`]
          : [],
      ),
    ).toEqual(["appear code-appeared pending P0300", "clear code-cleared pending P0300"]);
  });
});
