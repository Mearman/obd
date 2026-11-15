/** SLCAN: a CAN adapter that speaks the ASCII SLCAN protocol over a serial device. */

import { RawCanTransport } from "../core/rawcan.js";
import { SlcanLink } from "../core/slcan.js";
import type { AdapterAddress } from "../core/transport.js";
import {
  SerialTransport,
  openSystemSerialPort,
  parseBaud,
  type SerialPortFactory,
} from "./serial.js";

/**
 * Builds the `slcan` transport for an adapter URL: an ELM327 look-alike over a CAN adapter on a
 * serial device such as `/dev/tty.usbmodem1`. The `baud` parameter sets the serial speed (default
 * 115200); the CAN bit rate is chosen later by the session.
 *
 * @param openPort Builds the serial port; defaults to a real `serialport` port.
 * @throws AdapterUrlError when `baud` is not a positive whole number.
 */
export function slcanTransportFor(
  address: AdapterAddress,
  openPort: SerialPortFactory = openSystemSerialPort,
): RawCanTransport {
  const serial = new SerialTransport(address.target, parseBaud(address), openPort);
  return new RawCanTransport(new SlcanLink(serial), `SLCAN ${address.target}`);
}
