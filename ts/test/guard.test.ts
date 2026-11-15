import { describe, expect, it } from "vitest";
import {
  ACTUATION_MAX_MS,
  ACTUATION_SERVICE,
  ActuatorToken,
  CLEAR_SERVICE,
  ClearToken,
  DIAG_PROTOCOLS,
  DiagProtocol,
  GuardError,
  MemorySnapshotStore,
  Permit,
  READ_ONLY,
  WRITE_SERVICE,
  WriteToken,
  authoriseActuation,
  authoriseClear,
  authoriseWrite,
  fromHex,
  permit,
  toUpperHex,
} from "../src/core/index.js";

const PROTOCOLS_WITH_WRITES = [DiagProtocol.KWP2000, DiagProtocol.UDS] as const;
type WriteProtocol = (typeof PROTOCOLS_WITH_WRITES)[number];

// A write, its read and an actuation start and stop per protocol. The bytes are invented and
// address nothing on a real car.
const WRITE: Record<WriteProtocol, string> = { kwp2000: "3B0A0102", uds: "2E01230102" };
const START: Record<WriteProtocol, string> = { kwp2000: "300A07FF", uds: "2F012303FF" };
const STOP: Record<WriteProtocol, string> = { kwp2000: "300A00", uds: "2F012300" };

// Services that stay refused even with a write or actuation token in hand: clear without its own
// token, security access, reset, routine control, communication control, data transfer, control
// DTC setting.
const ALWAYS_REFUSED: Record<WriteProtocol, number[]> = {
  kwp2000: [0x11, 0x14, 0x27, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x3d],
  uds: [0x11, 0x14, 0x27, 0x28, 0x31, 0x34, 0x35, 0x36, 0x37, 0x38, 0x3d, 0x85, 0x87],
};

// Services that change something on a car: clear, actuator and routine control, writes, security
// access, reset, and download or programming transfer.
const REFUSED: Record<DiagProtocol, number[]> = {
  kwp2000: [0x11, 0x14, 0x27, 0x2e, 0x2f, 0x30, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3b],
  uds: [0x11, 0x14, 0x27, 0x28, 0x2e, 0x2f, 0x31, 0x34, 0x35, 0x36, 0x37, 0x3d, 0x85],
  obd: [0x04, 0x08],
};

const ALLOWED: Record<DiagProtocol, string[]> = {
  kwp2000: ["1081", "1092", "12FF040123", "170123", "1802FF00", "1A86", "2101", "3E"],
  uds: ["1001", "1003", "1083", "1902FF", "22F190", "3E00"],
  obd: ["0100", "020200", "03", "0600", "07", "0902", "0A"],
};

const SERVICES = Array.from({ length: 0x100 }, (_, service) => service);

function writeSnapshot(store: MemorySnapshotStore, name: string, requestHex: string): string {
  store.write(name, JSON.stringify({ write_request: requestHex, previous_value: "0000" }));
  return name;
}

function savedClear(store: MemorySnapshotStore): string {
  store.write("snapshot.json", "{}");
  return "snapshot.json";
}

describe("services that change the car are refused", () => {
  for (const protocol of DIAG_PROTOCOLS) {
    it.each(REFUSED[protocol])(`${protocol} service %i`, async (code) => {
      await expect(permit(protocol, Uint8Array.of(code, 0x01, 0x00))).rejects.toThrow(GuardError);
    });
  }
});

describe("read-only requests pass", () => {
  for (const protocol of DIAG_PROTOCOLS) {
    it.each(ALLOWED[protocol])(`${protocol} %s`, async (requestHex) => {
      const granted = await permit(protocol, fromHex(requestHex));
      expect(granted.payload).toEqual(fromHex(requestHex));
    });
  }
});

describe("only default and standard sessions pass", () => {
  it.each([
    [DiagProtocol.KWP2000, "1085"], // programming session
    [DiagProtocol.KWP2000, "1086"], // development session
    [DiagProtocol.KWP2000, "1087"], // adjustment session
    [DiagProtocol.KWP2000, "10"],
    [DiagProtocol.UDS, "1002"], // programming session
    [DiagProtocol.UDS, "1082"], // programming session, reply suppressed
    [DiagProtocol.UDS, "1060"],
  ] as const)("%s %s is refused", async (protocol, requestHex) => {
    await expect(permit(protocol, fromHex(requestHex))).rejects.toThrow(GuardError);
  });
});

it("refuses an empty request", async () => {
  await expect(permit(DiagProtocol.UDS, new Uint8Array(0))).rejects.toThrow(GuardError);
});

it("copies the request, so changing it afterwards does not change what was passed", async () => {
  const request = fromHex("1092");
  const granted = await permit(DiagProtocol.KWP2000, request);
  request[1] = 0x85;
  expect(granted.payload).toEqual(fromHex("1092"));
});

describe("clearing fault codes", () => {
  it("needs a saved snapshot", async () => {
    const store = new MemorySnapshotStore();
    await expect(authoriseClear(store, "missing.json")).rejects.toThrow(GuardError);
    store.write("empty.json", "");
    await expect(authoriseClear(store, "empty.json")).rejects.toThrow(GuardError);
  });

  it.each(DIAG_PROTOCOLS)("passes %s only with a token", async (protocol) => {
    const store = new MemorySnapshotStore();
    const request = Uint8Array.of(CLEAR_SERVICE[protocol], 0xff, 0x00);
    await expect(permit(protocol, request)).rejects.toThrow(GuardError);
    const token = await authoriseClear(store, savedClear(store));
    expect((await permit(protocol, request, token)).payload).toEqual(request);
  });

  it("authorises nothing else", async () => {
    const store = new MemorySnapshotStore();
    const token = await authoriseClear(store, savedClear(store));
    for (const request of ["3101", "2E0001", "1A86", "2701"]) {
      await expect(permit(DiagProtocol.KWP2000, fromHex(request), token)).rejects.toThrow(
        GuardError,
      );
    }
  });

  it("is void once its snapshot is gone", async () => {
    const store = new MemorySnapshotStore();
    const token = await authoriseClear(store, savedClear(store));
    store.remove("snapshot.json");
    await expect(permit(DiagProtocol.KWP2000, fromHex("14FF00"), token)).rejects.toThrow(
      GuardError,
    );
  });
});

describe("every service outside the read-only table is refused without a token", () => {
  for (const protocol of DIAG_PROTOCOLS) {
    it(`${protocol}, all 256 service IDs`, async () => {
      for (const code of SERVICES) {
        if (READ_ONLY[protocol].has(code)) continue;
        await expect(permit(protocol, Uint8Array.of(code, 0x01, 0x23, 0x00))).rejects.toThrow(
          GuardError,
        );
      }
    });
  }
});

describe("only the write service can be authorised as a write", () => {
  for (const protocol of PROTOCOLS_WITH_WRITES) {
    it.each(SERVICES)(`${protocol} service %i`, async (code) => {
      const store = new MemorySnapshotStore();
      const request = Uint8Array.of(code, 0x01, 0x23, 0x00);
      const snapshot = writeSnapshot(store, "s.json", toUpperHex(request));
      if (code === WRITE_SERVICE.get(protocol)) {
        const token = await authoriseWrite(store, snapshot, protocol, request);
        expect((await permit(protocol, request, token)).payload).toEqual(request);
      } else {
        await expect(authoriseWrite(store, snapshot, protocol, request)).rejects.toThrow(
          GuardError,
        );
      }
    });
  }
});

describe("only the actuation service can be authorised as an actuator test", () => {
  for (const protocol of PROTOCOLS_WITH_WRITES) {
    it.each(SERVICES)(`${protocol} service %i`, async (code) => {
      const start = Uint8Array.of(code, 0x01, 0x23, 0x03);
      const stop = Uint8Array.of(code, 0x01, 0x23, 0x00);
      if (code === ACTUATION_SERVICE.get(protocol)) {
        const tokens = authoriseActuation(protocol, start, stop, 1000);
        expect((await permit(protocol, start, tokens.start)).payload).toEqual(start);
      } else {
        expect(() => authoriseActuation(protocol, start, stop, 1000)).toThrow(GuardError);
      }
    });
  }
});

describe.each(PROTOCOLS_WITH_WRITES)("%s writes and actuation", (protocol) => {
  const write = fromHex(WRITE[protocol]);
  const start = fromHex(START[protocol]);
  const stop = fromHex(STOP[protocol]);

  it("have no route on the OBD path", async () => {
    const store = new MemorySnapshotStore();
    const snapshot = writeSnapshot(store, "s.json", WRITE[protocol]);
    await expect(authoriseWrite(store, snapshot, DiagProtocol.OBD, write)).rejects.toThrow(
      GuardError,
    );
    expect(() => authoriseActuation(DiagProtocol.OBD, start, stop, 1000)).toThrow(GuardError);
  });

  it("are refused without a token", async () => {
    for (const request of [write, start, stop]) {
      await expect(permit(protocol, request)).rejects.toThrow(/command/);
    }
  });

  it("let a write token pass its request once", async () => {
    const store = new MemorySnapshotStore();
    const token = await authoriseWrite(
      store,
      writeSnapshot(store, "s.json", WRITE[protocol]),
      protocol,
      write,
    );
    expect((await permit(protocol, write, token)).payload).toEqual(write);
    await expect(permit(protocol, write, token)).rejects.toThrow(/already been used/);
  });

  it("do not let a write token authorise any other request", async () => {
    const store = new MemorySnapshotStore();
    const snapshot = writeSnapshot(store, "s.json", WRITE[protocol]);
    const others = [
      START[protocol],
      STOP[protocol],
      WRITE[protocol] + "FF",
      WRITE[protocol].slice(0, -2) + "03",
      ...ALWAYS_REFUSED[protocol].map((code) => `${code.toString(16).padStart(2, "0")}0123`),
    ];
    for (const other of others) {
      const token = await authoriseWrite(store, snapshot, protocol, write);
      await expect(permit(protocol, fromHex(other), token)).rejects.toThrow(GuardError);
      expect(token.spent).toBe(false);
    }
    const otherProtocol = PROTOCOLS_WITH_WRITES.find((candidate) => candidate !== protocol);
    expect(otherProtocol).toBeDefined();
    if (otherProtocol === undefined) return;
    const token = await authoriseWrite(store, snapshot, protocol, write);
    await expect(permit(otherProtocol, write, token)).rejects.toThrow(GuardError);
  });

  it("let actuation tokens pass their own request once", async () => {
    const tokens = authoriseActuation(protocol, start, stop, 1000);
    await expect(permit(protocol, stop, tokens.start)).rejects.toThrow(GuardError);
    await expect(permit(protocol, start, tokens.stop)).rejects.toThrow(GuardError);
    expect((await permit(protocol, start, tokens.start)).payload).toEqual(start);
    expect((await permit(protocol, stop, tokens.stop)).payload).toEqual(stop);
    for (const [request, token] of [
      [start, tokens.start],
      [stop, tokens.stop],
    ] as const) {
      await expect(permit(protocol, request, token)).rejects.toThrow(/already been used/);
    }
  });

  it("do not let actuation tokens authorise any other service", async () => {
    const tokens = authoriseActuation(protocol, start, stop, 1000);
    for (const code of [WRITE_SERVICE.get(protocol), ...ALWAYS_REFUSED[protocol]]) {
      expect(code).toBeDefined();
      if (code === undefined) continue;
      await expect(
        permit(protocol, Uint8Array.of(code, ...start.slice(1)), tokens.start),
      ).rejects.toThrow(GuardError);
    }
    expect(tokens.start.spent).toBe(false);
  });

  it("do not let write or actuation tokens pass a clear", async () => {
    const clear = Uint8Array.of(CLEAR_SERVICE[protocol], 0xff, 0x00);
    const store = new MemorySnapshotStore();
    const tokens = authoriseActuation(protocol, start, stop, 1000);
    const writeToken = await authoriseWrite(
      store,
      writeSnapshot(store, "s.json", WRITE[protocol]),
      protocol,
      write,
    );
    for (const token of [writeToken, tokens.start, tokens.stop]) {
      await expect(permit(protocol, clear, token)).rejects.toThrow(GuardError);
    }
  });

  it("do not let a clear token pass a write or actuation", async () => {
    const store = new MemorySnapshotStore();
    const token = await authoriseClear(store, savedClear(store));
    for (const request of [write, start, stop]) {
      await expect(permit(protocol, request, token)).rejects.toThrow(GuardError);
    }
  });

  it("need a snapshot of that request", async () => {
    const store = new MemorySnapshotStore();
    await expect(authoriseWrite(store, "missing.json", protocol, write)).rejects.toThrow(
      GuardError,
    );
    store.write("empty.json", "");
    await expect(authoriseWrite(store, "empty.json", protocol, write)).rejects.toThrow(GuardError);
    const other = writeSnapshot(store, "other.json", WRITE[protocol] + "FF");
    await expect(authoriseWrite(store, other, protocol, write)).rejects.toThrow(/does not record/);
    store.write("no-previous.json", JSON.stringify({ write_request: WRITE[protocol] }));
    await expect(authoriseWrite(store, "no-previous.json", protocol, write)).rejects.toThrow(
      /no previous value/,
    );
    store.write("array.json", "[]");
    await expect(authoriseWrite(store, "array.json", protocol, write)).rejects.toThrow(GuardError);
  });

  it("void a write token once its snapshot is gone, leaving it unspent", async () => {
    const store = new MemorySnapshotStore();
    const snapshot = writeSnapshot(store, "s.json", WRITE[protocol]);
    const token = await authoriseWrite(store, snapshot, protocol, write);
    store.remove(snapshot);
    await expect(permit(protocol, write, token)).rejects.toThrow(/has gone/);
    expect(token.spent).toBe(false);
  });

  it("refuse a write without a value", async () => {
    const store = new MemorySnapshotStore();
    const bare = write.slice(0, 1 + (protocol === DiagProtocol.KWP2000 ? 1 : 2));
    const snapshot = writeSnapshot(store, "s.json", toUpperHex(bare));
    await expect(authoriseWrite(store, snapshot, protocol, bare)).rejects.toThrow(/no value/);
  });

  it("bound an actuator test", () => {
    authoriseActuation(protocol, start, stop, ACTUATION_MAX_MS);
    for (const durationMs of [0, -1, ACTUATION_MAX_MS + 100]) {
      expect(() => authoriseActuation(protocol, start, stop, durationMs)).toThrow(/at most/);
    }
  });

  it("need the stop request to hand back the same identifier", () => {
    const elsewhere = stop.slice();
    elsewhere[1] = (elsewhere[1] ?? 0) ^ 0xff;
    expect(() => authoriseActuation(protocol, start, elsewhere, 1000)).toThrow(/same identifier/);
    expect(() => authoriseActuation(protocol, start, start, 1000)).toThrow(/same as the start/);
  });

  it("are not issued if the token's request is changed afterwards", async () => {
    const mutable = write.slice();
    const store = new MemorySnapshotStore();
    const token = await authoriseWrite(
      store,
      writeSnapshot(store, "s.json", WRITE[protocol]),
      protocol,
      mutable,
    );
    mutable[mutable.length - 1] = 0x7f;
    expect((await permit(protocol, write, token)).payload).toEqual(write);
  });
});

it("issues tokens only through the guard", () => {
  const store = new MemorySnapshotStore();
  expect(() => new WriteToken({}, DiagProtocol.UDS, fromHex(WRITE.uds), store, "s.json")).toThrow(
    GuardError,
  );
  expect(() => new ActuatorToken({}, DiagProtocol.UDS, fromHex(START.uds))).toThrow(GuardError);
  expect(() => new ClearToken({}, store, "s.json")).toThrow(GuardError);
  expect(() => new Permit({}, DiagProtocol.UDS, fromHex("3E00"), 0x3e)).toThrow(GuardError);
});

describe("no token opens a programming or other session", () => {
  it.each([
    [DiagProtocol.KWP2000, "1085"],
    [DiagProtocol.KWP2000, "1086"],
    [DiagProtocol.KWP2000, "1087"],
    [DiagProtocol.UDS, "1002"],
    [DiagProtocol.UDS, "1004"],
  ] as const)("%s %s", async (protocol, requestHex) => {
    const store = new MemorySnapshotStore();
    const request = fromHex(requestHex);
    const tokens = authoriseActuation(
      protocol,
      fromHex(START[protocol]),
      fromHex(STOP[protocol]),
      1000,
    );
    const write = await authoriseWrite(
      store,
      writeSnapshot(store, "s.json", WRITE[protocol]),
      protocol,
      fromHex(WRITE[protocol]),
    );
    for (const token of [tokens.start, tokens.stop, write]) {
      await expect(permit(protocol, request, token)).rejects.toThrow(GuardError);
    }
  });
});
