# Generic standards layer for reading any road vehicle over OBD-II

This document covers the standards layer that any tool (`obd-read`) needs before it touches a manufacturer-specific protocol: the J1962 connector, the five legislated OBD-II protocols and how a car is matched to one, the ELM327 and STN adapter command sets that drive them, the SAE J1979 diagnostic modes and PID support bitmaps, ISO-TP framing, the UDS and KWP2000 service and negative-response vocabularies, addressing, and the pitfalls of cheap adapters. DoIP and J2534 get a short section each. Anything inferred or not confirmed from a source I could open is tagged "unconfirmed" with the reason. Write services (clear codes, actuator control, programming, security access) are out of scope and mentioned only to say so.

Primary sources used throughout: the [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf), the [OBDLink Family Reference and Programming Manual (FRPM)](https://www.obdlink.com/frpm/) (which documents the STN command set), and the Wikipedia pages on [On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics), [OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs), [ISO 15765-2](https://en.wikipedia.org/wiki/ISO_15765-2) and [Unified Diagnostic Services](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services). The SAE and ISO standards themselves are paywalled and were not read.

## 1. The J1962 connector and its pin map

The OBD-II connector is a 16-pin (2 by 8) J1962 socket. Pin assignments per [Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics):

- Pin 2: J1850 bus positive (PWM and VPW).
- Pin 10: J1850 bus negative (PWM only).
- Pin 6: CAN high (ISO 15765-4, SAE J2284).
- Pin 14: CAN low.
- Pin 7: K-line (ISO 9141-2 and ISO 14230-4).
- Pin 15: L-line (optional, ISO 9141-2 and ISO 14230-4).
- Pin 4: chassis ground. Pin 5: signal ground.
- Pin 16: battery positive (12 V on type A, 24 V on type B).
- Pins 1, 3, 8, 9, 11, 12, 13: manufacturer discretion. Examples given: GM J2411 on pin 1, and Ethernet on pins 3, 8, 11, 12, 13 in some vehicles.

Pin 8 is also the usual DoIP activation line ([IME-Actia DoIP overview](https://www.ime-actia.de/en/?p=5053)). A vehicle may leave pins populated for other buses (for example a second CAN on pins 3 and 11); those are manufacturer-specific and not part of the legislated set.

## 2. Legislated protocols and how to tell which a car uses

The five legislated signalling protocols ([Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics)):

| ELM number | Protocol                               | Notes                                                |
| ---------- | -------------------------------------- | ---------------------------------------------------- |
| 1          | SAE J1850 PWM, 41.6 kbit/s             | Used by Ford. Pins 2 and 10.                         |
| 2          | SAE J1850 VPW, 10.4 kbit/s             | Used by GM. Pin 2 only.                              |
| 3          | ISO 9141-2, 5-baud init, 10.4 kbaud    | Chrysler, European and Asian vehicles. K-line pin 7. |
| 4          | ISO 14230-4 KWP2000, 5-baud init       | K-line pin 7.                                        |
| 5          | ISO 14230-4 KWP2000, fast init         | K-line pin 7.                                        |
| 6          | ISO 15765-4 CAN, 11-bit ID, 500 kbit/s | Pins 6 and 14.                                       |
| 7          | ISO 15765-4 CAN, 29-bit ID, 500 kbit/s | Pins 6 and 14.                                       |
| 8          | ISO 15765-4 CAN, 11-bit ID, 250 kbit/s | Pins 6 and 14.                                       |
| 9          | ISO 15765-4 CAN, 29-bit ID, 250 kbit/s | Pins 6 and 14.                                       |

The ELM numbering (and the A, B, C user protocols for SAE J1939 and user CAN) is from the [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf), Figure 2. The J1850 manufacturer attributions come from Wikipedia and describe historical practice, not a rule a tool should rely on.

### Mandate dates

Per [Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics):

- United States: OBD-II mandatory for passenger cars and light gasoline trucks under 8,500 lb GVWR from model year 1996. All vehicles sold in the US were required to use ISO 15765-4 CAN from 2008.
- European Union (EOBD): petrol vehicles from 1 January 2001 (new models from 1 January 2000); diesel from 1 January 2004 (new models from 1 January 2003).
- Australia (ADR 79/01): petrol from 1 January 2006, diesel from 1 January 2007, with new-model dates a year earlier.
- Japan (JOBD): exists as an OBD-II variant, but the page I read gives no date. Unconfirmed.

The remainder of the Wikipedia page (characters 100,000 onward) is navigation and references only, so it adds nothing; year-by-year protocol adoption in the EU (when CAN replaced K-line for each make) is not covered here. Unconfirmed: a general rule such as "European cars before about 2008 are K-line". Treat the year as a hint only.

### Telling which protocol a vehicle uses

- Do not guess from year alone. Let the adapter search (`ATSP0`), then read the result with `ATDP` (text) or `ATDPN` (number, prefixed `A` when auto-searching). Sources: [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf).
- Pin population is a quick discriminator (inference, unconfirmed against a primary source): pins 6 and 14 populated suggests CAN; pin 7 alone suggests K-line; pin 2 populated with pin 10 suggests J1850 PWM; pin 2 without pin 10 suggests VPW. Many cars populate pins that are not the OBD bus, so use it only to order the search.
- Search order: the ELM327 tries protocols in an order modified by which inputs are active, unless `ATSS` forces the standard (J1978) order; the first revisions used the strict numeric order. To avoid a slow search, once the protocol is known pin it with `ATSP n`. The datasheet notes that `ATSP` writes to EEPROM immediately, so `ATTP n` (try protocol) is the non-persistent form. Source: [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf).
- Within CAN, distinguish 11-bit from 29-bit and 250 from 500 kbit/s by trying protocols 6, 8, 7, 9. A wrong baud rate typically yields `CAN ERROR` or `UNABLE TO CONNECT`, which the datasheet attributes to a mismatched protocol or baud rate.

### K-line initialisation

- Slow init (protocols 3 and 4): a 5-baud address byte is sent to the ECU; the ELM327 defaults to address `$33` and `ATIIA hh` changes it (for example `ATIIA 7A`). `ATSI` performs a slow initiation on demand.
- Fast init (protocol 5): a timed low/high wake pulse. ELM327 programmable parameters 1A and 1B default to 25 ms active and 25 ms passive (value times 2.5 ms). `ATFI` performs a fast initiation.
- After init, the ELM327 generates the periodic wakeup (idle) message on protocols 3, 4 and 5 only; default bytes are `68 6A F1 01 00`, interval set by `ATSW hh` (units of 20 ms, default 0x92, about 3 s, `ATSW 00` stops it) and message overridden with `ATWM`.

All K-line details above are from the [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf). The wire-level ISO 9141-2 and ISO 14230-2 timing (T1 to T4, P1 to P4) was not read from the standards; unconfirmed.

## 3. ELM327 AT commands needed for reading

All from the [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf) unless stated.

| Command                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATZ`                                        | Reset all. Also restores header and filter defaults.                                                                                                                                                                                                                                                                                                                                |
| `ATE0`                                       | Echo off.                                                                                                                                                                                                                                                                                                                                                                           |
| `ATL0`                                       | Linefeeds off (common companion, not in the required list).                                                                                                                                                                                                                                                                                                                         |
| `ATS0`                                       | Print spaces off, shortens output.                                                                                                                                                                                                                                                                                                                                                  |
| `ATH1`                                       | Show header bytes (CAN ID) in responses. Needed to see which ECU answered.                                                                                                                                                                                                                                                                                                          |
| `ATSP n`, `ATSP An`, `ATSP0`                 | Set protocol, set protocol with auto fallback, automatic. Persisted to EEPROM.                                                                                                                                                                                                                                                                                                      |
| `ATTP n`, `ATTP An`                          | Try protocol without persisting (unless memory `ATM1` is on).                                                                                                                                                                                                                                                                                                                       |
| `ATDP`, `ATDPN`                              | Describe the current protocol by name or number.                                                                                                                                                                                                                                                                                                                                    |
| `ATSH xyz` / `ATSH xxyyzz` / `ATSH wwxxyyzz` | Set request header: 3 hex digits for an 11-bit CAN ID, 3 bytes for J1850 and ISO, 4 bytes for a 29-bit CAN ID. Use for physical addressing.                                                                                                                                                                                                                                         |
| `ATCRA hhh` / `ATCRA hhhhhhhh`               | Set the CAN receive address filter to one ID. `ATCRA` with no argument resets. `ATAR` auto-sets the receive address from the header.                                                                                                                                                                                                                                                |
| `ATCF`, `ATCM`                               | Lower-level CAN filter and mask (mask bit 1 means the bit must match).                                                                                                                                                                                                                                                                                                              |
| `ATFCSH hhh` / `ATFCSH hhhhhhhh`             | CAN flow-control header (the ID the adapter uses when it sends flow control).                                                                                                                                                                                                                                                                                                       |
| `ATFCSD [1-5 bytes]`                         | CAN flow-control data bytes; the rest are filler.                                                                                                                                                                                                                                                                                                                                   |
| `ATFCSM h`                                   | Flow-control mode: 0 fully automatic (default), 1 fully user-defined, 2 user-defined data bytes only. Modes 1 and 2 error unless the needed data or ID has been set.                                                                                                                                                                                                                |
| `ATCFC0` / `ATCFC1`                          | Automatic CAN flow control off/on (default on). Off is useful when experimenting with non-OBD CAN.                                                                                                                                                                                                                                                                                  |
| `ATST hh`                                    | Response timeout in units of 4 ms (CAN with `CTM5`: 20 ms). `00` is special. Adaptive timing (`ATAT0/1/2`, default 1) never exceeds this.                                                                                                                                                                                                                                           |
| `ATCAF1` / `ATCAF0`                          | CAN auto-formatting on (default): the adapter builds PCI bytes when sending and strips them, plus unused padding, when receiving; multi-frame replies print as a length line plus numbered segments (`0:`, `1:` and so on). Off gives raw frames; it still pads transmitted frames to eight bytes but adds no PCI byte. With `ATH1` the printed form reverts to mostly as-received. |
| `ATIIA hh`                                   | ISO slow-init address (default `$33`).                                                                                                                                                                                                                                                                                                                                              |
| `ATSW hh`                                    | Wakeup interval, units of 20 ms.                                                                                                                                                                                                                                                                                                                                                    |
| `ATWM [1-6 bytes]`                           | Wakeup message bytes.                                                                                                                                                                                                                                                                                                                                                               |
| `ATPC`                                       | Protocol close.                                                                                                                                                                                                                                                                                                                                                                     |
| `ATBI`                                       | Bypass initialisation. The datasheet says it is for ECU simulators and demonstrators, not routine OBD use; a tool should not use it.                                                                                                                                                                                                                                                |
| `ATAT0/1/2`, `ATR0/1`                        | Adaptive timing and whether to wait for responses (with `R0` no response is awaited).                                                                                                                                                                                                                                                                                               |
| `ATCEA [hh]`                                 | CAN extended addressing: insert `hh` as the first data byte, and filter received frames on it. `ATCEA` alone turns it off.                                                                                                                                                                                                                                                          |
| `ATFE`, `ATD`                                | Forget events (such as a fatal CAN error that blocks CAN searching); set defaults.                                                                                                                                                                                                                                                                                                  |
| `ATRV`                                       | Read input voltage. Useful as a sanity check that the adapter sees the vehicle battery.                                                                                                                                                                                                                                                                                             |
| `ATDM1`, `ATMA`, `ATMR`, `ATMT`              | Monitoring commands; listen-only use, may flood the buffer (see pitfalls).                                                                                                                                                                                                                                                                                                          |

Notes:

- With auto-formatting on (`CAF1`), the adapter strips the ISO-TP length/PCI bytes, so a request is just the OBD bytes (`01 00`). Many diagnostic tools turn it off only for non-OBD experiments.
- Setting `ATSH` before the protocol is active makes those header bytes the first request's header; the datasheet recommends setting headers after a protocol is active so wakeup messages use defaults.
- A CAN receive filter can silently hide valid replies. If a physical request gets no response, `ATCRA` (no argument) or `ATAR` restores the default.

## 4. STN extras (OBDLink, STN11xx, STN21xx)

The STN interpreter ICs implement the ELM327 command set and add `ST` commands that coexist with `AT` commands. The authoritative reference is the [OBDLink FRPM](https://www.obdlink.com/frpm/). Commands used below are quoted from its summary and descriptions; I did not read every ST command.

- `STDI`: print the device hardware ID string (for example a product name and revision). `STI` prints the firmware ID string. Use `STI` (not `ATI`) to recognise an STN device, since clones copy `ATI` replies. Unconfirmed: that `STI` is rejected by every ELM clone; I did not test that.
- `STPX [h:header,] [d:data | l:length,] [t:timeout,] [r:responses,] [x:extra,] [f:flags]`: send an arbitrary message. Examples in the manual: `STPX h:686AF1, d:0100, t:50, r:1` and `STPX d:0100`. It switches transmit segmentation on for that message only. `h` defaults to the `ATSH` value; `t` overrides `STPTO`; `r` overrides `ATR`. In `l:` mode the adapter returns a `DATA>` prompt for longer messages, with a device-dependent maximum size (2k or 4k per the manual).
- `STFPA pattern,mask` (older name `STFAP`): add a hardware pass filter, 0 to 5 bytes, MSB first; for 11-bit CAN the first two bytes form the ID, for 29-bit the first four. Example from the manual: `STFPA 07E8,07FF`. `STFBA` adds a block filter with the same syntax, `STFFCA` a CAN flow-control filter, `STFAC` clears all filters, `STFPC`/`STFBC` clear pass/block filters. The FRPM's own mapping table lists `STFAP` as the older name of `STFPA`; I took that from the table and did not test `STFAP` on hardware.
- `STCAF format[,tt]`: CAN addressing format: 0 normal, 1 extended with target address, 2 mixed with target address extension.
- `STCFCPA txid[ext], rxid[ext]`: register a flow-control address pair (for example `STCFCPA 7E0, 7E8`, `STCFCPA 18DA10F1, 18DAF110`); `STCFCPC` clears them. Defaults cover the legislated OBD IDs.
- `STCSEGR 0|1` and `STCSEGT 0|1`: enable receive and transmit ISO-TP segmentation (off by default; `STCSEGT` is also used for raw CAN segmentation).
- `STCMM mode`: CAN monitoring mode: 0 receive only without ACKs (default), 1 normal node with ACKs, 2 receive everything including errors.
- `STPTO ms`, `STPTOT ms`, `STPTRQ ms`: OBD response timeout, transmit timeout, and minimum gap between last response and next request (P3 for ISO 9141-2 and 14230-4).
- `STPC`, `STPR`, `STPRS`: close the protocol, print protocol number, print protocol name.
- `STM [n]` and `STMA [n]`: monitor with current filters, or all traffic; `STSLU`, `STSLEEP` and related commands manage low-power behaviour.
- Writing or reprogramming facilities (periodic messaging, GPIO control, Bluetooth settings, programmable parameter writes) exist but are not covered by these notes.

## 5. SAE J1979 services (OBD-II modes 01 to 0A)

Names per [Wikipedia, OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs):

| Mode | Name                                                    | Read-only?                                                                                                                 |
| ---- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 01   | Show current data                                       | Yes                                                                                                                        |
| 02   | Show freeze frame data                                  | Yes                                                                                                                        |
| 03   | Show stored diagnostic trouble codes                    | Yes                                                                                                                        |
| 04   | Clear DTCs and stored values                            | No. Clears freeze frames and readiness. The tool sends it only through its guarded clear commands, after saving the codes. |
| 05   | Oxygen sensor monitoring test results                   | Yes, but non-CAN only (on CAN the data moved to mode 06)                                                                   |
| 06   | Other component or system monitoring test results       | Yes                                                                                                                        |
| 07   | Show pending DTCs                                       | Yes                                                                                                                        |
| 08   | Control operation of on-board component or system       | No. Not covered here.                                                                                                      |
| 09   | Request vehicle information (VIN, calibration IDs, CVN) | Yes                                                                                                                        |
| 0A   | Permanent DTCs                                          | Yes                                                                                                                        |

Modes 04 and 08 are the only ones outside read-only use in the set; this project's own rule is also not to clear codes before their history and freeze frame have been captured, because mode 04 destroys that evidence.

### Request and response shape

A positive response echoes the mode with 0x40 added (`01` becomes `41`, `09` becomes `49`) ([OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs)). A negative response is `7F`, the request service, and a reason code. On CAN the ISO-TP length byte precedes these.

### PID support bitmaps

PIDs 00, 20, 40 (and by the same pattern 60, 80, A0, C0) each return four bytes. Each bit says whether one of the next 32 PIDs is supported: PID 00 covers 01 to 20, PID 20 covers 21 to 40, PID 40 covers 41 to 60 ([OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs)). The most significant bit of the first byte is the first PID in the range. A set least significant bit of the fourth byte means the next bitmap PID (20, 40, ...) is itself supported, which tells you whether to query it. The "next bitmap" convention is how the page's encoding is normally read; the page itself only states the range mapping, so that detail is unconfirmed against the standard. Always discover supported PIDs by walking the bitmaps, per ECU, rather than assuming a list. Mode 09 has its own support bitmap at PID 00.

## 6. ISO-TP framing (ISO 15765-2)

From [Wikipedia, ISO 15765-2](https://en.wikipedia.org/wiki/ISO_15765-2). The high nibble of data byte 0 is the frame type:

- 0 Single Frame: complete payload, up to 7 bytes in normal addressing (6 with extended addressing). The low nibble is the payload length.
- 1 First Frame: starts a multi-frame message; a 12-bit total length spans the low nibble of byte 0 and byte 1, followed by the first data bytes. A 32-bit length variant exists in the 2016 revision (up to 2^32 minus 1 bytes). The ECU then waits for flow control.
- 2 Consecutive Frame: low nibble is a 4-bit sequence number. The first consecutive frame is 1, and the counter wraps from F to 0. The page calls its own description of the wrap inconsistent, so check the standard; this matches the common implementation.
- 3 Flow Control: low nibble is the flow status (0 continue, 1 wait, 2 overflow or abort); byte 1 is the block size (0 means send the rest without further flow control); byte 2 is STmin (0x00 to 0x7F is milliseconds, 0xF1 to 0xF9 is 100 to 900 microseconds).

For OBD, the receiver (your adapter) sends the flow-control frame to the physical request ID of the ECU that sent the first frame, on the paired transmit ID. With `ATCFC1` and `ATFCSM 0` the ELM327 does this automatically, and `ATFCSH`/`ATFCSD`/`ATFCSM 1` override it for non-OBD addressing ([ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)). Practical limits on payload are set by the adapter's buffers, not the 12-bit length.

Typical OBD multi-frame cases: mode 09 PID 02 (VIN), several mode 03 and mode 0A DTC lists, mode 06 results, and any UDS response longer than seven bytes.

## 7. Addressing

### 11-bit CAN

- Functional (broadcast) requests go to 0x7DF. Each OBD ECU listens on 0x7DF and on one physical ID in 0x7E0 to 0x7E7 and replies from its ID plus 8, so responses come from 0x7E8 to 0x7EF ([OBD-II PIDs](https://en.wikipedia.org/wiki/OBD-II_PIDs)).
- To reach one ECU, use `ATSH 7E0` (or 7E1 and so on) and filter replies with `ATCRA 7E8`.
- A request frame has the ISO-TP length in byte 0, the mode in byte 1, the PID in byte 2 and unused bytes after; Wikipedia recommends padding with 0xCC.
- Manufacturers also use IDs outside this range for non-OBD modules (the page's example is 0x720 for a Ford instrument cluster). Those are manufacturer-specific and belong to the manufacturer docs.

### 29-bit CAN

The ELM327 default CAN priority bits are 0x18 (`ATCP`), leaving the other 24 bits to `ATSH` ([ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)). Per a vendor document, the tester ID for ISO 15765 29-bit OBD defaults to 18DB33F1 ([DG Diagnostics manual](https://www.dgtech.com/wp-content/uploads/DGDiagOBDII.pdf), whose contents list states "ISO15765 29-bit CAN Tester ID (Default 18DB33F1)", read from the PDF itself). I read this as: `18DB33F1` is the functional request from tester F1 to address 33, `18DA<ECU>F1` is a physical request to an ECU, and `18DAF1<ECU>` is its response (for example `18DA10F1` to the engine ECU at 0x10, reply from `18DAF110`). The STN manual uses the pair `STCFCPA 18DA10F1, 18DAF110` as an example. The functional/physical split by `18DB` and `18DA` prefix is unconfirmed against ISO 15765-4, which is paywalled; the ID structure is exercised in the [OBDLink FRPM](https://www.obdlink.com/frpm/) only as an example, not as a rule.

### Non-CAN addressing

J1850 and ISO 9141-2/14230-4 use three header bytes (format/priority, target, source). The ELM327 uses `68 6A F1` for functional OBD (the same bytes appear in the wakeup message and in the STN `STPX` example, source F1), and `ATSH` can replace them. Physical addressing on K-line is manufacturer-specific. The ISO 14230 four-byte header with an explicit length byte is selected on the ELM327 by writing 0 in the second digit of the first header byte ([ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)).

## 8. UDS (ISO 14229)

UDS is the service layer for non-emissions diagnostics on CAN-era vehicles and is carried over ISO-TP (and DoIP). A positive response is the request service ID plus 0x40. A negative response is the three bytes `7F`, the request service ID and a negative response code (NRC). Source for the lists below: [Wikipedia, Unified Diagnostic Services](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services).

### Service IDs

Read-oriented services:

- 0x10 DiagnosticSessionControl (needed to enter an extended session on some ECUs, but a session change can alter ECU behaviour; use only the default session unless a read needs more, and treat any change as a deliberate step).
- 0x3E TesterPresent (keep-alive).
- 0x19 ReadDTCInformation.
- 0x22 ReadDataByIdentifier.
- 0x23 ReadMemoryByAddress, 0x24 ReadScalingDataByIdentifier, 0x2A ReadDataByPeriodicIdentifier (read-only in effect, but check ECU behaviour).

State-changing or access-granting services, not covered by these notes: 0x11 ECUReset, 0x14 ClearDiagnosticInformation, 0x27 SecurityAccess, 0x28 CommunicationControl, 0x29 Authentication, 0x2C DynamicallyDefineDataIdentifier, 0x2E WriteDataByIdentifier, 0x2F InputOutputControlByIdentifier, 0x31 RoutineControl, 0x34 RequestDownload, 0x35 RequestUpload, 0x36 TransferData, 0x37 RequestTransferExit, 0x38 RequestFileTransfer, 0x3D WriteMemoryByAddress, 0x83 AccessTimingParameter (withdrawn in ISO 14229-1:2020), 0x84 SecuredDataTransmission, 0x85 ControlDTCSettings, 0x86 ResponseOnEvent, 0x87 LinkControl.

### Negative response codes (common subset)

- 0x10 generalReject, 0x11 serviceNotSupported, 0x12 subFunctionNotSupported, 0x13 incorrectMessageLengthOrInvalidFormat, 0x14 responseTooLong.
- 0x21 busyRepeatRequest, 0x22 conditionsNotCorrect, 0x24 requestSequenceError, 0x25 noResponseFromSubnetComponent, 0x26 failurePreventsExecutionOfRequestedAction.
- 0x31 requestOutOfRange (typical for an unsupported data identifier), 0x33 securityAccessDenied, 0x35 invalidKey, 0x36 exceedNumberOfAttempts, 0x37 requiredTimeDelayNotExpired.
- 0x78 requestCorrectlyReceived-ResponsePending: the ECU needs more time; keep waiting for the final response instead of retrying.
- 0x7E subFunctionNotSupportedInActiveSession, 0x7F serviceNotSupportedInActiveSession.
- 0x81 to 0x94: condition-specific codes (rpmTooHigh, engineIsRunning, vehicleSpeedTooHigh, voltageTooLow, and so on).

A tool should treat 0x78 as "keep listening", 0x31 as "this ECU does not have that item", 0x11 and 0x12 as capability gaps, and 0x33 as "stop, this needs authentication we do not do".

## 9. KWP2000 (ISO 14230)

KWP2000 is the K-line service layer, and also runs over CAN on some vehicles (usually ISO 15765 transport) ([Wikipedia, Keyword Protocol 2000](https://en.wikipedia.org/wiki/Keyword_Protocol_2000)). Data rate 1.2 to 10.4 kbaud on K-line, up to 255 data bytes. ISO 14230-4 is the emissions part used for OBD. Service IDs per the [IME-Actia KWP2000 summary](https://www.ime-actia.de/en/?p=5089) (response is request plus 0x40):

- Session and identification: 0x10 StartDiagnosticSession, 0x20 StopDiagnosticSession, 0x3E TesterPresent, 0x1A ReadECUIdentification. 0x81 StartCommunication and 0x82 StopCommunication are the link-level services used after fast init (listed in an EU regulation annex per a search summary, not opened).
- Data: 0x21 ReadDataByLocalIdentifier, 0x22 ReadDataByCommonIdentifier, 0x23 ReadMemoryByAddress.
- Trouble codes: 0x12 ReadFreezeFrameData, 0x13 ReadDiagnosticTroubleCodes, 0x17 ReadStatusOfDiagnosticTroubleCodes, 0x18 ReadDiagnosticTroubleCodesByStatus.
- Not covered by these notes: 0x11 ECUReset, 0x14 ClearDiagnosticInformation, 0x27 SecurityAccess, 0x2C and 0x30 to 0x3D write, routine and I/O control services, and 0x34 to 0x37 transfer services.

The IME-Actia table lists WriteDataByCommonIdentifier as 0x3E, which collides with TesterPresent; its own page looks wrong there, so ignore that row (unconfirmed).

Negative responses use `7F`, the request SID and a code. Code values were not available from any source I opened. From general knowledge only, unconfirmed: KWP2000 uses codes such as 0x11 serviceNotSupported, 0x12 subFunctionNotSupported, 0x22 conditionsNotCorrect, 0x78 requestCorrectlyReceived-ResponsePending, and shares much of its numbering with UDS. Verify against ISO 14230-3 before depending on any value other than the `7F SID NRC` shape.

On K-line the KWP2000 message has a header (format byte with length, optional target and source bytes), data, and a checksum. The ELM327 and STN handle the header and checksum on the OBD protocols; `STPCB0` turns off automatic checksum on the STN, which a tool should not need.

## 10. DoIP (ISO 13400), short

DoIP carries UDS over Ethernet. Vehicle identification uses UDP broadcasts and vehicle announcement messages (the announcement carries the VIN and the unit's diagnostic address). Diagnostics run over TCP, normally on port 13400, after a routing activation request to the gateway ([IME-Actia DoIP](https://www.ime-actia.de/en/?p=5053), [AutoPi DoIP setup](https://docs.autopi.io/developer_guides/setting-up-doip/), port number from the search summary of the AutoPi and Scapy documentation). The Ethernet interface must first be activated; pin 8 of the J1962 connector is often the activation line. Ethernet itself is on manufacturer-defined pins (AutoPi lists 3, 11, 12, 13 or 1, 9, 12, 13 in two pinouts). Routing activation types are 00 default diagnostics, 01 WWH-OBD and E0 central security per the Quantex pages (search summary only). An ELM327 or STN adapter does not speak DoIP; this needs an Ethernet adapter and is not yet implemented in the tool. The Wikipedia pages for DoIP returned 404, so exact payload type numbers and field layouts are unconfirmed.

## 11. J2534, short

SAE J2534 is a PassThru API that lets one PC application drive a vendor's PassThru interface for diagnostics and ECU reprogramming across makes ([Kvaser, Introduction to SAE J2534](https://kvaser.com/about-can/can-standards/j2534/)). The API is a vendor DLL with functions such as `PassThruOpen`, `PassThruConnect`, `PassThruDisconnect`, `PassThruReadMsgs`, `PassThruWriteMsgs`, `PassThruStartMsgFilter`, `PassThruStopMsgFilter`, `PassThruIoctl` and `PassThruReadVersion`. J2534-1 covers the core API and ISO 15765 (ISO-TP) protocols; J2534-2 adds optional extensions such as J1939 and single-wire CAN; Revision 05.00 introduced a modernised API (Kvaser, via search summary). It was introduced for emissions-related reprogramming. For the `obd-read` tool it is a possible alternative backend where a PassThru interface is the only adapter available, but it is Windows-DLL oriented and flashing-focused, so it is not in scope for the ELM327/STN path. Unconfirmed: whether common PassThru DLLs can be loaded from macOS or Linux; I did not check.

## 12. Common adapter pitfalls

- **Clone chips.** Many cheap adapters report `ELM327 v1.5`, a version Elm Electronics never released, so that string signals a clone, and clones may report any false version ([Wikipedia, ELM327](https://en.wikipedia.org/wiki/ELM327); [ForScan forum, known problems with clones](https://forum.forscan.org/viewtopic.php?p=16201), search summary). Clones commonly answer `?` to less-common commands (for example `ATAT1`, `ATST`, `ATS0`) while returning `OK` to the basic ones, so a successful `ATZ`/`ATE0` proves little. A tool should probe the commands it depends on (`ATAT1`, `ATSH`, `ATCRA`, `ATFCSH`, `ATFCSD`, `ATFCSM`) and degrade explicitly, not assume them. Confirm STN presence with `STI`; confirm a genuine ELM327 by checking the commands in the [datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf). The forum evidence is anecdotal.
- **CAN ERROR.** The datasheet attributes it to difficulty initialising, sending or receiving on CAN: not connected to a CAN bus, wrong protocol, or a baud rate that does not match. It may also be wiring. If a car is not CAN, trying protocol 6 to 9 gives this error. [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf).
- **BUFFER FULL.** The ELM327 has a 512-byte transmit buffer to the host. On busy CAN (typically while monitoring) it fills faster than the serial link drains and data is lost. Mitigations from the datasheet: faster serial baud rate, `ATH0` and `ATS0`, and CAN filtering (`ATCRA`, `ATCF`/`ATCM`). The same applies to the STN with `STFPA`.
- **NO DATA, `?`, UNABLE TO CONNECT, BUS INIT: ERROR, BUS BUSY.** `NO DATA` means the timeout (`ATST` and adaptive timing) expired with no reply: wrong protocol, wrong header, ECU asleep, or an unsupported request. `?` is an unrecognised command. `BUS BUSY` means too much activity to insert a message. `<DATA ERROR` marks a line with a bad checksum or, with CAN auto-formatting on, a non-ISO 15765-4 frame. [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf).
- **Timeouts.** The default `ATST` is conservative, and the datasheet notes slow vehicles needed about 100 ms or longer. For functional requests where many ECUs reply, set `ATST` high enough to capture all of them or use `ATR` and count; adaptive timing never exceeds `ATST`.
- **Adapter-side header filtering.** The adapter keeps a receive filter set by `ATCRA`/`ATCF`/`ATCM` (and auto-set by `ATAR`). After changing `ATSH` to a physical address, the auto receive address follows it; if you set `ATCRA` manually it persists until you send `ATCRA` with no argument, `ATAR`, `ATD` or `ATZ`. A stale filter reads as `NO DATA`. STN hardware filters (`STFPA` and similar) are separate and cleared with `STFAC`.
- **Multi-frame handling.** `ATFCSM`, `ATCFC` and `ATCAF` change what the adapter does with a First Frame. If you turn off auto-formatting you must handle PCI bytes and sequence yourself.
- **Header display.** With `ATH1` multi-line responses are no longer collapsed into the `0:`/`1:` form the same way; parse on the header, not on line number.
- **Wakeup traffic.** On protocols 3 to 5 the adapter sends periodic idle messages; disabling them with `ATSW 00` makes the ECU time out.
- **Power and battery.** A car in standby may not respond; check `ATRV` before blaming the protocol.

## 13. Sources I could not open or fully read

- SAE J1979, SAE J1962, SAE J1850, ISO 9141-2, ISO 14230 (all parts), ISO 14229 (UDS), ISO 15765-2 and -4, ISO 13400, SAE J2534: paywalled; only public summaries read.
- [Wikipedia, Diagnostics over IP](https://en.wikipedia.org/wiki/Diagnostics_over_IP) and [Wikipedia, Doip](https://en.wikipedia.org/wiki/Doip): both returned HTTP 404.
- [Wikipedia, Keyword Protocol 2000](https://en.wikipedia.org/wiki/Keyword_Protocol_2000) and [Wikipedia, SAE J2534](https://en.wikipedia.org/wiki/SAE_J2534): opened but contain no service tables, NRCs, timings or API list.
- ISO 14230-3, KWP2000 negative response code values and ISO 9141-2/14230-2 init timing: not found in any source opened.
- Quantex ELM327-DoIP pages, ForScan clone threads, AutoPi and Scapy DoIP docs: seen only as search summaries, not opened.
- The DG Diagnostics PDF was read, but it only confirms the default tester ID; its description of response IDs was not found.
- OBDLink STN1110 and STN2120 datasheets: surfaced in search but not fetched.
- The OBDLink FRPM was read via a downloaded PDF through text extraction, which garbled some command text; STN commands should be re-checked against the manual before coding.

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- https://docs.autopi.io/developer_guides/setting-up-doip/ (http://web.archive.org/web/20260807194952/https://docs.autopi.io/developer_guides/setting-up-doip/)
- https://en.wikipedia.org/wiki/Doip (http://web.archive.org/web/20251105101245/https://en.wikipedia.org/wiki/DOiP)
- https://en.wikipedia.org/wiki/ELM327 (http://web.archive.org/web/20261027155858/https://en.wikipedia.org/wiki/ELM327)
- https://en.wikipedia.org/wiki/ISO_15765-2 (http://web.archive.org/web/20261012091016/https://en.wikipedia.org/wiki/ISO_15765-2)
- https://en.wikipedia.org/wiki/Keyword_Protocol_2000 (http://web.archive.org/web/20261030032840/https://en.wikipedia.org/wiki/Keyword_Protocol_2000)
- https://en.wikipedia.org/wiki/OBD-II_PIDs (http://web.archive.org/web/20261105015044/https://en.wikipedia.org/wiki/OBD-II_PIDs)
- https://en.wikipedia.org/wiki/On-board_diagnostics (http://web.archive.org/web/20261106030732/https://en.wikipedia.org/wiki/On-board_diagnostics)
- https://kvaser.com/about-can/can-standards/j2534/ (http://web.archive.org/web/20260310062837/https://kvaser.com/about-can/can-standards/j2534/)
- https://www.dgtech.com/wp-content/uploads/DGDiagOBDII.pdf (http://web.archive.org/web/20230618065215/https://www.dgtech.com/wp-content/uploads/DGDiagOBDII.pdf)
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf (http://web.archive.org/web/20261108174631/https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)
- https://www.obdlink.com/frpm/ (http://web.archive.org/web/20251014223742/https://www.obdlink.com/frpm/)

No snapshot found:

- https://en.wikipedia.org/wiki/Diagnostics_over_IP
- https://en.wikipedia.org/wiki/SAE_J2534
- https://en.wikipedia.org/wiki/Unified_Diagnostic_Services
- https://forum.forscan.org/viewtopic.php?p=16201
- https://www.ime-actia.de/en/?p=5053
- https://www.ime-actia.de/en/?p=5089

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://en.wikipedia.org/wiki/Diagnostics_over_IP
- https://en.wikipedia.org/wiki/Doip
