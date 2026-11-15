/** KWP2000 (ISO 14230-3) requests carried over CAN. */

import { byteAt, fromHex, toHex, toUpperHex } from "./bytes.js";
import type { Fault, UnitSession } from "./diag.js";
import { IdentField } from "./diag.js";
import { ElmError } from "./elm.js";
import { DiagProtocol, type ClearToken } from "./guard.js";

const START_SESSION = 0x10;
const READ_FREEZE_FRAME = 0x12;
const READ_LOCAL_IDENTIFIER = 0x21;
const CLEAR_FAULTS = 0x14;
const READ_FAULTS_BY_STATUS = 0x18;
const READ_IDENTIFICATION = 0x1a;

/** readECUIdentification option that asks for the unit's full identification record. */
const IDENT_OPTION = 0x86;

/** readDTCByStatus: report every identified code as two hexadecimal bytes plus a status byte. */
const STATUS_HEX_CODES = 0x02;

/** Group of fault codes meaning "all groups". */
const ALL_GROUPS = [0xff, 0x00];

/** readFreezeFrameData: search every stored frame, selecting by the fault code that follows. */
const ALL_FRAMES = 0xff;
const SELECT_BY_FAULT_CODE = 0x04;

/** The KWP2000 requests this tool sends to one control unit. */
export class Kwp2000 {
  readonly protocol = DiagProtocol.KWP2000;

  /**
   * @param session The addressed unit.
   * @param diagnosticSession The session sub-function the profile names, such as 0x92.
   */
  constructor(
    private readonly session: UnitSession,
    private readonly diagnosticSession: number,
  ) {}

  /** Opens the diagnostic session the profile names. */
  async start(): Promise<void> {
    await this.session.request(Uint8Array.of(START_SESSION, this.diagnosticSession));
  }

  /** Reads the unit's identification record. */
  async identification(): Promise<IdentField[]> {
    const reply = await this.session.request(Uint8Array.of(READ_IDENTIFICATION, IDENT_OPTION));
    return [new IdentField("identification", reply.slice(2))];
  }

  /**
   * Reads every stored fault code with its status byte.
   *
   * @throws ElmError when the reply's length does not match the count it declares.
   */
  async faults(): Promise<Fault[]> {
    const reply = await this.session.request(
      Uint8Array.of(READ_FAULTS_BY_STATUS, STATUS_HEX_CODES, ...ALL_GROUPS),
    );
    const count = reply[1];
    if (count === undefined) throw new ElmError(`short fault-code reply: ${toHex(reply)}`);
    const body = reply.slice(2);
    if (body.length !== 3 * count) {
      throw new ElmError(
        `fault-code reply declares ${String(count)} codes but carries ${toHex(body)}`,
      );
    }
    const faults: Fault[] = [];
    for (let index = 0; index < body.length; index += 3) {
      faults.push({
        code: toUpperHex(body.slice(index, index + 2)),
        status: byteAt(body, index + 2),
      });
    }
    return faults;
  }

  /** Reads the freeze frame stored with one fault code, as raw bytes. */
  async freezeFrame(fault: Fault): Promise<Uint8Array> {
    const reply = await this.session.request(
      Uint8Array.of(READ_FREEZE_FRAME, ALL_FRAMES, SELECT_BY_FAULT_CODE, ...fromHex(fault.code)),
    );
    return reply.slice(1);
  }

  /**
   * Reads one local identifier and returns the data bytes that follow it in the reply.
   *
   * @throws ElmError when the reply names a different identifier.
   */
  async readValue(identifier: number): Promise<Uint8Array> {
    const reply = await this.session.request(Uint8Array.of(READ_LOCAL_IDENTIFIER, identifier));
    if (reply.length < 2 || reply[1] !== identifier) {
      throw new ElmError(
        `reply ${toHex(reply)} does not answer local identifier ${toUpperHex(Uint8Array.of(identifier))}`,
      );
    }
    return reply.slice(2);
  }

  /** Erases every stored fault code. Needs the token that proves a snapshot was saved. */
  async clear(token: ClearToken): Promise<void> {
    await this.session.request(Uint8Array.of(CLEAR_FAULTS, ...ALL_GROUPS), token);
  }
}
