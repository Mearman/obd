/**
 * A scripted adapter with one control unit at the engine address, for the write and actuator
 * tests. The bytes the tests use are invented and address nothing on a real car.
 */

import {
  DiagProtocol,
  Elm,
  MemorySnapshotStore,
  fromHex,
  type AdapterInfo,
  type UnitAddress,
  type UnitProfile,
  type WritableSnapshotStore,
} from "../../src/core/index.js";
import { FakeElmCore, KwpEcu, UdsEcu, fakeTransport, type Responder } from "./fake-elm.js";

/** The engine unit's address pair, as the profiles give it. */
export const ENGINE: UnitAddress = { name: "engine", requestId: 0x7e0, responseId: 0x7e8 };

/** An in-memory store that can create snapshots, refusing to replace one that exists. */
export class WritableMemoryStore extends MemorySnapshotStore implements WritableSnapshotStore {
  async create(snapshot: string, text: string): Promise<void> {
    if (await this.exists(snapshot)) throw new Error(`${snapshot} already exists`);
    this.write(snapshot, text);
  }
}

/** One protocol's profile and an invented record or actuator. */
export interface ProtocolCase {
  readonly label: string;
  readonly profile: UnitProfile;
  readonly read: string;
  readonly write: string;
  readonly previous: string;
  readonly value: string;
  readonly start: string;
  readonly stop: string;
  readonly testerPresent: string;
  /** The positive reply's service byte to the start and stop requests. */
  readonly actuationReply: string;
  /** The key of the writable record in the fake unit. */
  readonly recordKey: number;
  /** A stored fault code the unit reports. */
  readonly fault: [number, number];
}

export const KWP: ProtocolCase = {
  label: "kwp2000",
  profile: {
    name: "mercedes-w211",
    status: "unconfirmed",
    protocol: DiagProtocol.KWP2000,
    session: 0x92,
  },
  read: "2142",
  write: "3B420203",
  previous: "0001",
  value: "0203",
  start: "304207FF",
  stop: "304200",
  testerPresent: "3E01",
  actuationReply: "70",
  recordKey: 0x42,
  fault: [0x1234, 0x20],
};

export const UDS: ProtocolCase = {
  label: "uds",
  profile: { name: "vag-mqb", status: "unconfirmed", protocol: DiagProtocol.UDS, session: 0x03 },
  read: "220142",
  write: "2E01420203",
  previous: "0001",
  value: "0203",
  start: "2F014203FF",
  stop: "2F014200",
  testerPresent: "3E00",
  actuationReply: "6F",
  recordKey: 0x0142,
  fault: [0x123456, 0x20],
};

export const CASES: readonly ProtocolCase[] = [KWP, UDS];

/** An initialised adapter with one unit answering at the engine address. */
export interface Rig {
  readonly core: FakeElmCore;
  readonly elm: Elm;
  readonly adapter: AdapterInfo;
  readonly responders: Record<number, Responder>;
}

/** Opens a rig whose engine unit is answered by `respond`. */
export async function openRig(respond: Responder): Promise<Rig> {
  const responders: Record<number, Responder> = { [ENGINE.requestId]: respond };
  const core = new FakeElmCore(responders);
  const elm = new Elm(fakeTransport(core));
  const adapter = await elm.initialise();
  await elm.selectCan(11, 500_000);
  return { core, elm, adapter, responders };
}

/** A fake unit of the case's protocol holding one writable record. */
export function unitFor(protocol: ProtocolCase, records: boolean): KwpEcu | UdsEcu {
  const ecu =
    protocol === KWP
      ? new KwpEcu(ENGINE.responseId, [protocol.fault])
      : new UdsEcu(ENGINE.responseId, [protocol.fault]);
  if (records) ecu.records.set(protocol.recordKey, fromHex(protocol.previous));
  return ecu;
}
