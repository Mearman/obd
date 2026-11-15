/** UDS (ISO 14229) requests carried over CAN. */

import { byteAt, fromHex, hexNumber, toHex, toUpperHex } from "./bytes.js";
import { IdentField, NegativeResponse, type Fault, type UnitSession } from "./diag.js";
import { ElmError } from "./elm.js";
import { DiagProtocol, type ClearToken } from "./guard.js";

const SESSION_CONTROL = 0x10;
const CLEAR_FAULTS = 0x14;
const READ_FAULT_INFORMATION = 0x19;
const READ_DATA_BY_IDENTIFIER = 0x22;

const REPORT_BY_STATUS_MASK = 0x02;
const REPORT_SNAPSHOT_BY_FAULT = 0x04;
const ANY_STATUS = 0xff;
const ALL_RECORDS = 0xff;
const ALL_FAULT_GROUPS = [0xff, 0xff, 0xff];

/** Identification data identifiers defined by ISO 14229-1. */
export const IDENT_FIELDS: ReadonlyMap<number, string> = new Map([
  [0xf190, "VIN"],
  [0xf187, "part number"],
  [0xf18c, "serial number"],
  [0xf195, "software version"],
]);

/** The UDS requests this tool sends to one control unit. */
export class Uds {
  readonly protocol = DiagProtocol.UDS;

  /**
   * @param session The addressed unit.
   * @param diagnosticSession The session sub-function the profile names, such as 0x03.
   */
  constructor(
    private readonly session: UnitSession,
    private readonly diagnosticSession: number,
  ) {}

  /** Opens the diagnostic session the profile names. */
  async start(): Promise<void> {
    await this.session.request(Uint8Array.of(SESSION_CONTROL, this.diagnosticSession));
  }

  /** Reads the standard identification values the unit supports. */
  async identification(): Promise<IdentField[]> {
    const fields: IdentField[] = [];
    for (const [identifier, label] of IDENT_FIELDS) {
      try {
        const reply = await this.session.request(
          Uint8Array.of(READ_DATA_BY_IDENTIFIER, identifier >> 8, identifier & 0xff),
        );
        fields.push(new IdentField(label, reply.slice(3)));
      } catch (error) {
        if (!(error instanceof NegativeResponse)) throw error;
        // the unit does not hold this value
      }
    }
    return fields;
  }

  /**
   * Reads every stored fault code with its status byte.
   *
   * @throws ElmError when the reply is not a whole number of four-byte records.
   */
  async faults(): Promise<Fault[]> {
    const reply = await this.session.request(
      Uint8Array.of(READ_FAULT_INFORMATION, REPORT_BY_STATUS_MASK, ANY_STATUS),
    );
    const body = reply.slice(3);
    if (reply.length < 3 || body.length % 4 !== 0) {
      throw new ElmError(`fault-code reply is not whole records: ${toHex(reply)}`);
    }
    const faults: Fault[] = [];
    for (let index = 0; index < body.length; index += 4) {
      faults.push({
        code: toUpperHex(body.slice(index, index + 3)),
        status: byteAt(body, index + 3),
      });
    }
    return faults;
  }

  /** Reads the snapshot records stored with one fault code, as raw bytes. */
  async freezeFrame(fault: Fault): Promise<Uint8Array> {
    const reply = await this.session.request(
      Uint8Array.of(
        READ_FAULT_INFORMATION,
        REPORT_SNAPSHOT_BY_FAULT,
        ...fromHex(fault.code),
        ALL_RECORDS,
      ),
    );
    return reply.slice(2);
  }

  /**
   * Reads one data identifier and returns the data bytes that follow it in the reply.
   *
   * @throws ElmError when the reply names a different identifier.
   */
  async readValue(identifier: number): Promise<Uint8Array> {
    const reply = await this.session.request(
      Uint8Array.of(READ_DATA_BY_IDENTIFIER, identifier >> 8, identifier & 0xff),
    );
    if (reply.length < 3 || ((byteAt(reply, 1) << 8) | byteAt(reply, 2)) !== identifier) {
      throw new ElmError(
        `reply ${toHex(reply)} does not answer data identifier ${hexNumber(identifier, 4)}`,
      );
    }
    return reply.slice(3);
  }

  /** Erases every stored fault code. Needs the token that proves a snapshot was saved. */
  async clear(token: ClearToken): Promise<void> {
    await this.session.request(Uint8Array.of(CLEAR_FAULTS, ...ALL_FAULT_GROUPS), token);
  }
}
