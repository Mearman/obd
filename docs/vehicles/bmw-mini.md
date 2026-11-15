# BMW and Mini diagnostics through the OBD-II port with an ELM327 or STN adapter

BMW and Mini diagnostics split into three eras with different physical layers. Pre-D-CAN cars use K-line (BMW DS2 framing, later KWP2000), cars from roughly the mid-2000s use CAN with BMW's extended-address ISO-TP style (tester CAN ID 0x6F1, ECU replies on 0x600 plus the ECU address, ECU address as the first data byte), and F-series and newer cars add Ethernet (HSFZ, TCP 6801) through an ENET cable. A stock ELM327 can do the CAN era (user-defined protocol B with ATSH, ATCEA, ATFCSH, ATFCSD, ATFCSM and ATCRA), cannot speak DS2 (it lacks even-parity serial and the framing), and cannot do HSFZ or DoIP unless the adapter firmware implements them (Quantex documents one that does). The standard BMW tooling (EDIABAS, INPA, ISTA, EdiabasLib) describes each ECU in SGBD files (.prg and .grp) and the open projects below document those and the transport layers. Module addresses vary by chassis and bus, so every address in this document is a starting point to verify against the SGBD for the car, never a constant. This document is about reading only: coding, adaptation and flashing are out of scope for `obd-read`.

## Scope and evidence

Claims carry an inline source. Anything inferred, or confirmed only by a single secondary source, is tagged "unconfirmed" with the reason. No primary BMW specification was found, so every wire-level detail comes from reverse-engineering projects, open diagnostic tools, vendor notes or training material and should be checked against captures from the target car. "Reported" below means a source states it; "confirmed" means two independent sources agree or working code depends on it; nothing here has been read from a car by `obd-read`.

## Era overview

| Era (approximate)                               | Physical layer at the OBD port                         | Application protocol                             | ELM327 stock firmware                                                   |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Pre-2000s (round 20-pin connector on many cars) | K-line                                                 | DS2 (9600 baud, even parity), some ECUs KWP2000  | No DS2                                                                  |
| Late 1990s to mid-2000s (16-pin OBD-II)         | K-line on pin 7, sometimes with a second K-line        | DS2, KWP2000 (BMW-FAST), ISO 9141 for emissions  | Emissions modes only (unconfirmed for BMW-specific services, see below) |
| Mid-2000s onward (E-series with D-CAN)          | D-CAN on pins 6 and 14, 500 kbit/s                     | KWP2000 over CAN or UDS, BMW extended addressing | Yes, via user-defined CAN protocol                                      |
| F-series and newer                              | D-CAN and Ethernet (ENET cable, pin 8 activation line) | UDS over CAN or HSFZ                             | CAN only; Ethernet not through an ELM327                                |

Mini shares the BMW tooling and the same diagnostic stack in the generations built on BMW platforms (EDIABAS and Deep OBD cover Mini; unconfirmed per model, as no source lists Mini chassis codes in the pages read).

## K-line era

### Physical layer and connectors

- Pin 7 of the 16-pin OBD-II connector is the bidirectional K-line for ISO 9141 and KWP2000 at up to 10.4 kbit/s, and pin 15 (the L-line) was used on older cars to wake the ECU: https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols
- BMW cars of roughly 1987 to 2000 carry a round 20-pin diagnostic connector, and a Foxwell adapter exists to reach it from OBD-II tools: https://bimmerworld.com/Foxwell-20-Pin-Round-Port-Adapter-for-1987-2000-BMW.html
- One forum report for a 2004-2005 BMW maps OBD pin 7 to round-connector pins 17 and 20 (two K-lines, bridged for single-line cables) and pin 15 to pin 15: https://www.bimmerforums.com/forum/showthread.php?p=19053287 (unconfirmed: single forum post, one car).
- The EdiabasLib firmware page says older E-series cars need a link between pins 7 and 8 to reach every ECU: https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html

### DS2 framing

- Serial settings are 9600 baud, 8 data bits, even parity, 1 stop bit (8E1), with no slow-init handshake ("direct init"): https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html
- Frame layout is `[ADDR][LEN][CMD][DATA...][CS]`. LEN is the total frame length including ADDR, LEN and CS, and CS is the XOR of all preceding bytes: https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html
- K-line is half-duplex and shares a wire for transmit and receive, so the interface reads back its own transmitted bytes as an echo before the ECU's reply: https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-analysis.html and, for a DS2 implementation noting the ECU echo, https://github.com/pazi88/ds2
- Another DS2 source describes one-byte and two-byte address variants with a trailing XOR: https://os.mbed.com/users/openobc/code/e36obd/docs/tip/DS2_8h_source.html (unconfirmed: a header code comment, not a specification).
- The related BMW body-bus framing (I-Bus and K-Bus) is `[SRC][LEN][DST][DATA...][CS]` with LEN counting the bytes after it. It shares serial settings with DS2 but is a different bus, not on the OBD port of most cars: https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html. Address tables for that bus are in https://github.com/piersholt/wilhelm-docs#ki-bus and are not the OBD diagnostic addresses.

### KWP2000 on K-line

- KWP2000 (ISO 14230) runs at 10400 baud, 8N1, with fast init or 5-baud init. The format byte's top two bits select the addressing mode (physical, functional, or none) and the low six bits carry the length, with a separate length byte when they are zero. Common addresses are 0x33 for the emissions ECU, 0xF1 for the tester and 0x7F for functional broadcast: https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html
- The same page lists 9600 and 115200 variants and a TesterPresent (0x3E) keep-alive about every two seconds by default. The 115200 variant is the fast K-line used by "BMW-FAST" on K+DCAN cables (unconfirmed for the ELM327 route: the page does not tie 115200 to BMW-FAST by name).

### What a stock ELM327 can and cannot do on K-line

- The ELM327 datasheet supports ISO 9141-2 and ISO 14230-4 and offers `AT IB 10`, `AT IB 48` and `AT IB 96` to change the ISO baud rate (10400, 4800 and 9600): https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
- The datasheet's terminal instructions refer to 8 data bits, no parity, 1 stop bit, and the text extract searched for parity and 8E1 settings found no way to select even parity on the vehicle side. Together with the DS2 requirement of even parity this means a stock ELM327 cannot be expected to speak DS2 (unconfirmed: inferred from the absence of a parity command in the datasheet text, not from a statement that DS2 is unsupported). Deep OBD's adapter-type table does state that ELM327 adapters do not support DS2: https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html
- The datasheet's frame handling for the ISO protocols assumes the OBD-II header format and checksum. Whether BMW-specific KWP2000 services over K-line can be sent through `AT SP 5` with `AT SH` is not documented in any BMW source read (unconfirmed).
- EdiabasLib's replacement ELM327 firmware adds K-line support for all protocols on supported hardware (PIC18F25K80 parts without an MCP2515): https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html and https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html. This is a different firmware, so it is outside the "stock ELM327" case. The firmware page does not mention DS2 by name.

## CAN era

### Buses and the gateway

- E-series cars have several CAN buses: K-CAN (body, 100 kbit/s), PT-CAN (powertrain, 500 kbit/s) and F-CAN (chassis, 500 kbit/s), plus D-CAN, the diagnostic CAN on OBD pins 6 and 14 at 500 kbit/s: https://dzid26.github.io/opendbc-BMW-E8x-E9x and https://github.com/dzid26/opendbc-BMW-E8x-E9x
- E65-era training material lists K-CAN-S and K-CAN-P at 100 kbit/s and PT-CAN at 500 kbit/s, with the later E60 merging the K-CAN variants: https://archive.org/download/BMWTechnicalTrainingDocuments/ST042%20E65%20Complete%20Vehicle%20%28Part%201%29/03_E65%20Bus%20Systems.pdf
- A central gateway module (ZGM) converts between PT-CAN and body-side buses according to gateway rules, and later cars use a junction box electronics module (JBE) or a body-domain controller in the same role. Which unit is the gateway behind the OBD port depends on the model: https://archive.org/download/BMWTechnicalTrainingDocuments/ST811%20F01%20Complete%20Vehicle/03.1_F01%20Bus%20Systems.pdf (unconfirmed for any given car: forum reports differ on whether the DSC or a junction box plays the gateway role on E9x, e.g. https://www.spoolstreet.com/threads/e9x-bench-setup.6469).
- For a tool this means a request to an ECU on K-CAN or PT-CAN is addressed from D-CAN and routed by the gateway, so the ECU address, not the bus, is what the request names.

### BMW extended-address ISO-TP

- Tester requests use CAN ID 0x6F1 (0x600 plus tester address 0xF1). ECU replies use 0x600 plus the ECU address (the DME's reply is 0x612). The first data byte carries the other party's address (the ECU address in a request, 0xF1 in a response), followed by the ISO-TP PCI byte and the UDS or KWP payload. Confirmed by three independent sources: a write-up for the G29 and J29 platform (https://thesecretingredient.neocities.org/bmw), the OVMS i3 module, whose identifiers are 0x6F1 plus the unit address for transmit and 0x600 plus the address with 0xF1 for receive, polled with `ISOTP_EXTADR` (https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/tree/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/ecu_definitions and https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/src/vehicle_bmwi3.cpp), and EdiabasLib's ELM327 driver, which sets the header to `0x600 | source` (0x6F1 for the tester) and the extended address to the target (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/EdiabasLib/EdiabasLib/EdElmInterface.cs).
- Worked example from the write-up, for the G29 and J29 platform: request `12 03 22 43 00 CC CC CC` on 0x6F1, response `F1 05 62 43 00 0D BA CC` on 0x612, where `22` is ReadDataByIdentifier, `62` the positive response and `CC` padding. The page reads it as coolant temperature, `0x0DBA * 0.1 - 273.14`, and prints about 80.96 °C, but that formula gives 78.26 °C for those bytes, so either the bytes or the scaling in the example are wrong (contradiction within the source). The page also says the OBD port's D-CAN connects only to the central gateway (ZGM).
- Quantex's BMW example uses the same scheme with the ECU address on the reply ID: tester 0x6F1, ECU 0x40 replying on 0x640, and ECU 0x10 replying on 0x610. With headers on, its one positive reply prints as `610F10662F1500F25F0`, which the page annotates "610=CAN ID, F1=tester, 06=length", so the adapter prints the tester address between the identifier and the PCI byte: https://www.quantexlab.com/en/develop/elm327.html. The 0x40 unit gave NO DATA to `1A80` and `22F150`; the page names neither unit or the car.
- The ELM327 datasheet describes the same scheme as "CAN Extended Addressing": "the first byte is used for the receiver's (ie target's) address. The remaining seven bytes are used as described previously", and its worked example uses a tester at F1 (https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf, "Using CAN Extended Addresses"). ISO 15765-2 calls this extended addressing; the standard itself was not opened.

### Configuring an ELM327 for it

The Quantex page documents a working sequence, which maps onto the datasheet's user-defined protocol B and extended address commands (https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf):

- `ATPBC101` and `ATSPB` define and select user protocol B as 11-bit, ISO 15765, 500 kbit/s. Whether a stock ELM327 or only the Quantex firmware accepts that exact `PBC` value is not stated, so check the datasheet's protocol B options for the adapter in hand (unconfirmed). The options byte 0xC1 sets bit 6 as well as bit 7, which in the datasheet's PP 2C description selects variable data length rather than fixed eight-byte frames.
- `ATBI` bypasses the standard OBD initialisation. The page warns it is intended for simulators and demonstrators: https://www.quantexlab.com/en/develop/elm327.html
- `ATSH6F1` sets the request ID. `ATCEA<addr>` sets the extended address byte. `ATCRA6<addr>` restricts receive to the ECU's reply ID.
- Flow control is set by hand: `ATFCSH6F1`, `ATFCSD` with the first byte the ECU address followed by the flow-control PCI (for example `4030FF32`), and `ATFCSM1`. The page says mode 1 only works when the flow-control header and data are already defined.
- `ATCEA` with no argument turns extended addressing off. It is off by default.
- Extended addressing and ISO-TP PCI both consume a data byte, so frames carrying eight data bytes can lose data: https://www.quantexlab.com/en/develop/elm327.html and the datasheet section on CAN extended addresses.
- Quantex reports that a read to one ECU returned NO DATA while another answered, so each target needs its own ATCEA, ATCRA and flow-control data. Mailing-list reports of silence when using 6F1 with extended addressing on an ELM327 clone exist: https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/message/IMLSGRPCPG53OQ7I36WI3XIPTD7E6SOH/ (unconfirmed: a single thread about an unspecified adapter).
- The DME setup is `ATSH6F1`, `ATCEA12`, `ATCRA612` plus flow control to 0x6F1 with first byte 0x12. Confirmed in shape by EdiabasLib's driver, which for each request sends `ATFCSD` with the target address followed by `30`, block size and separation time, then `ATCEA` with the target and `ATFCSM1` (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/EdiabasLib/EdiabasLib/EdElmInterface.cs).

What the datasheet and the STN manual add:

- `AT CEA hh` "causes the ELM327 to insert the hh value as the first data byte of all CAN messages that you send. It also adds one more filtering step to received messages, only passing ones that have the Tester Address in the first byte position", and it can be changed at any time. The tester address is the one set by `AT TA` (F1 by default), not `AT RA`. Extended addressing arrived in v1.4 per the version history. Its worked example sets the flow control by hand with `AT FC SD 04 30 FF 00` for a unit at address 04 (ELM327 datasheet, "CEA hh", "RA hh", "Using CAN Extended Addresses" and "Version History").
- The OBDLink manual lists `ATCEA` and `ATCEA hh` as supported "for backwards compatibility only. Use STCAF instead", and gives `STPX` an `x` parameter, "ISO 15765: extended address (overrides value, set by ATCEA command)" (OBDLink FRPM revision F, https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf, "ATCEA" and "STPX").

EdiabasLib drives an ELM327 two ways (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/EdiabasLib/EdiabasLib/EdElmInterface.cs):

- For a standard ELM327 it does ISO-TP itself: initialisation includes `ATSH6F1`, `ATCF600`, `ATCM700` (accept every identifier from 0x600 to 0x6FF), `ATPBC001` and `ATSPB` (protocol B without ISO 15765 formatting), `ATH1` and `ATAT0`, and it builds each frame with the target address first.
- For adapters that identify as Carly or WGSoft it lets the adapter do ISO-TP: `ATPBC101` and `ATBI`, then per request the `ATFCSD`, `ATCEA`, `ATFCSM1` sequence above, with block size 0 and separation time 0 (2 for Carly). It parses those adapters' reply lines as a three-digit identifier, the address byte and then the PCI byte, the same layout Quantex prints.

Contradiction on frame length: EdiabasLib (0xC0 and 0xC1) and Quantex (0xC1) select variable-length frames, while the G29 write-up's frames are eight bytes padded with 0xCC in both directions. `obd-read` sends fixed eight-byte frames (protocol 6 at 500 kbit/s), which the G29 example shows a unit accepting; whether every BMW unit accepts padded frames is unconfirmed.

Deep OBD states that standard ELM327 adapters work with BMW D-CAN only (March 2007 onward), and that only particular hardware revisions (1.4b, 1.5, original 2.1 on PIC18F25K80 without an MCP2515) are suitable, counterfeit and ARM-based clones often fail: https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html

### Which families an ELM327 or STN adapter reaches

- Deep OBD's adapter table: ELM327 adapters support BMW-FAST on "D-CAN only" and "Only D-CAN is supported (BMW vehicles starting from 3/2007)"; DS2 is not supported; for "BMW models with ENET (F series or higher with HSFZ or DoIP protocol)" the ELM327 row says D-CAN. DS2 cars (E36, E38, E39, E46, E52, E53, E83, E85 and E86 in its list) need an OBD pin 7 and 8 connection in the adapter. Recommended ELM327s are 1.4b, 1.5 and the original 2.1 on PIC18F25K80 without an MCP2515; fake PIC18F25K80 parts do not work and ARM-based adapters are "in most cases not 100% ELM327 compatible": https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html
- So the reachable families are E-series cars with D-CAN (from 3/2007) and F, G and I-series cars over D-CAN. K-line cars and the Ethernet path are not reachable with an ELM327 or STN adapter (reported by Deep OBD; the STN case is an inference from the STN manual offering no Ethernet).
- Gateway: the G29 write-up says the OBD port's D-CAN connects only to the ZGM, so every request is routed by the gateway (reported, https://thesecretingredient.neocities.org/bmw). On the FEM F-series car below, FEM_GW at 0x10 is the gateway unit, and Quantex's example got a UDS reply from 0x10 (reported; Quantex names no car).
- Ignition and bus wake: the OVMS i3 notes say the car answers on the OBD port with the ignition on and for about 40 seconds after it is switched off or woken (locking, a remote command), wakes about every 30 minutes while charging, and sounds the alarm if anything is left plugged in when locked: https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/docs/index.rst. No source read gives the equivalent for other families.

### Module addresses

BMW addresses are assigned per bus and chassis family, not globally. Each table below is one source's list for one family; read the real list from the SGBD or from an ECU scan before relying on any row.

F-series with a front electronics module (FEM), from a coding notes repository's list for one model-year 2016 car, as E-Sys shows it over ENET; the list says it is incomplete and some functions are deduced, and it names no model (https://github.com/jokinawa/bmw-f/blob/6dc45abae7b8fc8d883d0375308e675235e5e83b/readme.md). Units it gives as `[XX]` (no address) are AAG, ACC, AHM, AMP, AMPH, ASA, EGS and ZGW. Addresses are hexadecimal.

| Unit     | Address | Function as the source gives it                   |
| -------- | ------- | ------------------------------------------------- |
| ACSM     | 0x01    | Advanced crash and safety management              |
| TRSVC    | 0x06    | Surround view camera system                       |
| HC2      | 0x08    | Heading control (lane change warning)             |
| GHAS     | 0x0F    | not given                                         |
| FEM_GW   | 0x10    | Front electronics module gateway                  |
| DME2     | 0x12    | Digital motor electronics                         |
| EKPM2    | 0x17    | Electronic fuel pump control                      |
| ICM      | 0x1C    | Integrated chassis management                     |
| DSC      | 0x29    | Dynamic stability control                         |
| EPS      | 0x30    | Electronic power steering                         |
| TBX      | 0x35    | iDrive controller touch handwriting module        |
| AMPT     | 0x37    | Top amplifier                                     |
| ASD      | 0x3F    | Active sound design                               |
| FEM_BODY | 0x40    | Front electronics module (ZGW, FRM, CAS, JBBF)    |
| TMS      | 0x41    | LED headlight secondary module                    |
| TMS      | 0x42    | LED headlight secondary module                    |
| LHM      | 0x43    | LED headlight main module                         |
| LHM      | 0x44    | LED headlight main module                         |
| FZD      | 0x56    | Roof function unit                                |
| KAFAS2   | 0x5D    | Camera-based driver assistance                    |
| KOMBI    | 0x60    | Instrument cluster                                |
| ATM      | 0x61    | not given                                         |
| HU_NBT2  | 0x63    | Head unit NBT, second version                     |
| ZBE3     | 0x67    | iDrive controller                                 |
| SM2      | 0x6D    | Seat module                                       |
| SM2      | 0x6E    | Seat module                                       |
| REM      | 0x72    | Rear electronics module                           |
| VDC1     | 0x76    | Vertical dynamics management                      |
| IHKA3    | 0x78    | Integrated automatic heating and air conditioning |

i3 and i3s (I01), from the OVMS module's identifier definitions, used by read-only polling code developed against a 2018 i3s (https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/tree/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/ecu_definitions): SME 0x07, EDM 0x12, LIM 0x14, KLE 0x15, EME 0x1A, SAS 0x22, DSC 0x29, EPS 0x30, BDC 0x40, FZD 0x56, KAF 0x5D, KOM 0x60, NBT 0x63, ZBE 0x67, IHX 0x78. The OVMS README for these definitions says they derive from EdiabasLib and Deep OBD and are GPL-3.0; only the addresses are used here.

G29 and J29: the engine (DME) at 0x12 is the only address the write-up gives; it names the BDC and KOMBI without addresses (https://thesecretingredient.neocities.org/bmw).

E-series with D-CAN: no source read names units with addresses. EdiabasLib's E90 simulation file sends BMW-FAST requests (format byte, target, source 0xF1) to targets 0x00, 0x01, 0x12, 0x17, 0x29, 0x30, 0x40, 0x55, 0x56, 0x60, 0x62, 0x63, 0x64, 0x72 and 0x78 (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/obd.sim), and the E90 error page lists ACSM, CAS, CCC-BO, CCC-GW, DDE, DSC, EKPS, IHK, KBM, KGM, KOMBI, PDC, RLS, EPS, ULF and FZD by SGBD name only (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/Errors.ccpage). Pairing the two would be a guess.

Where the families agree and disagree:

- 0x12 is the engine on the FEM car (DME2), the i3 (EDM) and the G29 (DME), and the most used target in the E90 simulation (confirmed across families).
- 0x29 is DSC, 0x30 EPS, 0x56 FZD, 0x5D KAFAS, 0x60 KOMBI, 0x63 the head unit, 0x67 ZBE and 0x78 the climate unit in both the FEM list and the i3 (confirmed for those two families).
- 0x40 is FEM_BODY on the FEM car and the BDC on the i3, both body controllers with different names.
- Earlier rows in this document gave DSC as 0x34 and KOMBI as 0x60 without a source; both F-era sources give DSC 0x29, and KOMBI 0x60 is now confirmed for the F-era. EGS 0x18 remains unconfirmed (the FEM list gives EGS no address). The I-Bus address 0x80 for the cluster at https://github.com/piersholt/wilhelm-docs is a different bus.
- Functional broadcast over ENET is 0xDF: https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html

The ISTA control-unit list at https://www.mvwautotechniek.nl/en/bmw-ista-list-of-control-units-and-legend names control units and may help to build a table (not opened for addresses).

### Protocols per family

- K-line cars: DS2, and KWP2000 on K-line on later cars (see "K-line era").
- E-series with D-CAN: KWP2000 framed as BMW-FAST; EdiabasLib's E90 simulation file holds BMW-FAST telegrams such as `83 00 F1 22 20 00` and `84 00 F1 18 02 FF FF` (https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/obd.sim). The D_CAS group file's concept table lists BMW-FAST, KWP2000 and DS2 (https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/D_CAS/).
- F, G and I-series over D-CAN: UDS (ReadDataByIdentifier 0x22 in the i3 polling code, the G29 example and the Quantex example).
- F-series and later over Ethernet: HSFZ or DoIP (see below).

## Ethernet era (ENET, HSFZ and DoIP)

- F-series and newer cars expose Ethernet through the OBD connector. Deep OBD describes an ENET WiFi adapter for F-models and says an ENET cable leaves the car on a link-local (APIPA) address, with the adapter defaulting to 192.168.100.1 and DHCP otherwise: https://uholeschak.github.io/ediabaslib/docs/ENET_WiFi_Adapter.html
- HSFZ is BMW's own framing over TCP port 6801, with vehicle discovery on UDP 6811. The header is a 4-byte length plus a 2-byte control word, addresses are one byte (tester 0xF4 by default), and no routing activation is needed, unlike DoIP (ISO 13400, port 13400, two-byte addresses, tester 0x0E80): https://www.quantexlab.com/en/develop/elm327_hsfz.html
- Scapy's HSFZ layer lists control words 0x01 for diagnostic data, 0x02 for acknowledgement, 0x11 for vehicle identification and 0x12 for alive check: https://scapy.readthedocs.io/en/stable/api/scapy.contrib.automotive.bmw.hsfz.html (the page snippet was partial). The ediabasx page on XEnet32 lists 0xF1 as the tester, 0x10 to 0xEF as ECU addresses and 0xDF as functional broadcast, and its drawn header differs from the Quantex description, so the exact layout is unconfirmed: https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html. Capture real traffic before relying on either.
- ELM327 and ENET: a stock ELM327 has no Ethernet interface and cannot reach HSFZ or DoIP. The Quantex page describes HSFZ (`AT SP E`) and DoIP (`AT SP D`) as protocols of its own adapter firmware, so those are firmware features of that product, not general ELM327 features: https://www.quantexlab.com/en/develop/elm327_hsfz.html. For `obd-read`, Ethernet-era cars are either read over D-CAN with the CAN-era scheme above, or need a real ENET cable and a direct HSFZ client in the tool (a design choice for the tool, not a requirement stated by a source).

## Tooling and description files

- EDIABAS is BMW's diagnostic runtime. INPA is the engineering tool that runs scripts on it, ISTA is the workshop application, and the ECU knowledge lives in SGBD description files (.prg for a variant, .grp for a group), each defining jobs and tables executed as BEST/2 bytecode: https://github.com/emdzej/ediabasx
- The EdiabasX SGBD reference lists each SGBD with its ECU, author, revision, language, job count and table count, and links per-file pages. It notes flash-only variants, group files and coding description files (`C_*.prg`). It does not itself document addresses or protocols beyond hints in names: https://emdzej.github.io/ediabasx-docs-sgbd
- Which SGBD matches a car is chosen from a group file's identification job, so a read-only tool needs the SGBD files for the target ECUs. The SGBD files themselves are BMW's and are not redistributed by these projects (unconfirmed: licensing of the files was not checked).

## Open projects and notes

- EdiabasX documentation, covering interfaces, K-line, protocols and the CLI: https://emdzej.github.io/ediabasx-docs/. The source is a TypeScript port of EdiabasLib licensed under PolyForm Noncommercial 1.0.0: https://github.com/emdzej/ediabasx
- EdiabasX SGBD reference: https://emdzej.github.io/ediabasx-docs-sgbd (source https://github.com/emdzej/ediabasx-docs-sgbd, unconfirmed: repository named on the site, not opened)
- EdiabasLib, the .NET EDIABAS interpreter library behind Deep OBD: https://github.com/uholeschak/ediabaslib and its documentation at https://uholeschak.github.io/ediabaslib/docs/Documentation.html (adapter types, ELM327 replacement firmware, config file, ENET adapter pages)
- Deep OBD for BMW and VAG: https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html. Deep OBD offers coding features too, which `obd-read` does not (out of scope).
- Quantex ELM327 pages for BMW addressing and HSFZ: https://www.quantexlab.com/en/develop/elm327.html and https://www.quantexlab.com/en/develop/elm327_hsfz.html
- ELM327 datasheet: https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
- BimmerCode and BimmerLink: the adapters page at bimmercode.app/adapters was not reachable in this research, so no public technical notes from them are cited. App Store and retailer pages indicate that K+DCAN cables serve E-series and ENET adapters serve F and G series, but those are retail claims (unconfirmed).
- BMW I-Bus and K-Bus documentation (a body bus, not the OBD diagnostic path): https://github.com/piersholt/wilhelm-docs
- Open Vehicle Monitoring System, BMW i3 module (read-only polling over the OBD socket's CAN): https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/tree/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/ecu_definitions, https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/src/vehicle_bmwi3.cpp and https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/docs/index.rst
- jokinawa/bmw-f, F-series coding notes with a unit list (GPL-3.0; only addresses used): https://github.com/jokinawa/bmw-f/blob/6dc45abae7b8fc8d883d0375308e675235e5e83b/readme.md

## Capability summary for obd-read

| Era                         | Stock ELM327                                                              | STN                                                                    | Notes                                                          |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| DS2 K-line                  | No (needs even parity and DS2 framing)                                    | Unconfirmed: no DS2 mode found in the manual                           | Use a K+DCAN or replacement-firmware route                     |
| KWP2000 K-line              | Standard OBD modes only; BMW services unconfirmed                         | Unconfirmed                                                            | Replacement firmware lists K-line support                      |
| D-CAN with extended address | Yes with ATSH, ATCEA, ATFCSH, ATFCSD, ATFCSM, ATCRA, on suitable hardware | Yes: ATCEA is kept for compatibility and STPX takes the address as `x` | One unit per configuration; clones often fail                  |
| Ethernet (HSFZ)             | No                                                                        | No                                                                     | Use D-CAN, or a direct HSFZ client                             |
| DoIP                        | No                                                                        | No                                                                     | Mentioned for completeness; no BMW source here ties it to cars |

## What obd-read ships

The core implements the D-CAN scheme: a profile unit's `extended_address` makes the session send `ATCEA` with it, put it first in the flow-control data, leave six bytes for a single-frame request, send longer requests through STPX with `x` on STN adapters, and require and remove the tester address F1 from every reply frame. The raw CAN links do the same framing in software. Every row below is unconfirmed until `obd-read probe` reads it from a car.

- `bmw-f-fem`: the FEM F-series table above, UDS in the default session. Confirmation: https://github.com/Mearman/obd/issues/20
- `bmw-i3`: the i3 table above, UDS in the default session. Confirmation: https://github.com/Mearman/obd/issues/22
- `bmw-g29`: the engine at 0x12 with the coolant value from the write-up's example. Confirmation and the other units: https://github.com/Mearman/obd/issues/23

Excluded, each with a deferred issue holding its revisit trigger:

- E-series with D-CAN: reachable, but no source names the units at each address: https://github.com/Mearman/obd/issues/17
- K-line cars (DS2, KWP2000 on K-line): need a K+DCAN cable (FTDI serial) and a DS2 transport: https://github.com/Mearman/obd/issues/18
- F and G series over ENET (HSFZ or DoIP): need an ENET cable and an HSFZ client; an ELM327 or STN adapter has no Ethernet: https://github.com/Mearman/obd/issues/19
- F-series without a FEM (F01, F10 and others): no address table: https://github.com/Mearman/obd/issues/21
- Mini: no source lists Mini units or addresses: https://github.com/Mearman/obd/issues/24

## Out of scope

Coding, adaptation, programming and flashing (ISTA programming, E-Sys, NCS Expert, SGBD flash variants) are not part of `obd-read`. Read-only services (ReadDataByIdentifier 0x22, ReadDTCInformation 0x19 and the KWP equivalents) are the intended use. This document does not claim these services are safe on every ECU, so a tool should send only what the matching SGBD documents for the target module.

## Archived copies

A Wayback Machine snapshot for each cited page: the ones dated 2026-11-15 were saved when the BMW profiles were added, the others are the latest found earlier. Pages with no snapshot are listed after.

- https://emdzej.github.io/ediabasx-docs-sgbd (https://web.archive.org/web/20261104192926/https://emdzej.github.io/ediabasx-docs-sgbd/)
- https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/D_CAS/ (https://web.archive.org/web/20261115130501/https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/D_CAS/)
- https://emdzej.github.io/ediabasx-docs/ (https://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-analysis.html (https://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-analysis.html)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html (https://web.archive.org/web/20261104192915/https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html (https://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html)
- https://github.com/jokinawa/bmw-f (https://web.archive.org/web/20200914082941/https://github.com/jokinawa/bmw-f)
- https://github.com/jokinawa/bmw-f/blob/6dc45abae7b8fc8d883d0375308e675235e5e83b/readme.md (https://web.archive.org/web/20261115124957/https://github.com/jokinawa/bmw-f/blob/6dc45abae7b8fc8d883d0375308e675235e5e83b/readme.md)
- https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/docs/index.rst (https://web.archive.org/web/20261115125134/https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/docs/index.rst)
- https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/src/vehicle_bmwi3.cpp (https://web.archive.org/web/20261115125153/https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/src/vehicle_bmwi3.cpp)
- https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/tree/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/ecu_definitions (https://web.archive.org/web/20261115125115/https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/tree/ca04b74626d482f0deaf5e43793e82fba0aeece1/vehicle/OVMS.V3/components/vehicle_bmwi3/ecu_definitions)
- https://github.com/piersholt/wilhelm-docs (https://web.archive.org/web/20260102111000/https://github.com/piersholt/wilhelm-docs)
- https://github.com/uholeschak/ediabaslib (https://web.archive.org/web/20260621070412/https://github.com/uholeschak/ediabaslib)
- https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/Errors.ccpage (https://web.archive.org/web/20261115125343/https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/Errors.ccpage)
- https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/obd.sim (https://web.archive.org/web/20261115125325/https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/BmwDeepObd/Xml/E90/obd.sim)
- https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/EdiabasLib/EdiabasLib/EdElmInterface.cs (https://web.archive.org/web/20261115125302/https://github.com/uholeschak/ediabaslib/blob/a8659168681985cd76e5b547848325cd91410269/EdiabasLib/EdiabasLib/EdElmInterface.cs)
- https://os.mbed.com/users/openobc/code/e36obd/docs/tip/DS2_8h_source.html (https://web.archive.org/web/20241029173029/https://os.mbed.com/users/openobc/code/e36obd/docs/tip/DS2_8h_source.html)
- https://scapy.readthedocs.io/en/stable/api/scapy.contrib.automotive.bmw.hsfz.html (https://web.archive.org/web/20250215124044/https://scapy.readthedocs.io/en/stable/api/scapy.contrib.automotive.bmw.hsfz.html)
- https://thesecretingredient.neocities.org/bmw (https://web.archive.org/web/20261115124840/https://thesecretingredient.neocities.org/bmw/)
- https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html (https://web.archive.org/web/20261115124918/https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html)
- https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html (https://web.archive.org/web/20260615203124/https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html)
- https://uholeschak.github.io/ediabaslib/docs/Documentation.html (https://web.archive.org/web/20260310185831/https://uholeschak.github.io/ediabaslib/docs/Documentation.html)
- https://uholeschak.github.io/ediabaslib/docs/ENET_WiFi_Adapter.html (https://web.archive.org/web/20261115124936/https://uholeschak.github.io/ediabaslib/docs/ENET_WiFi_Adapter.html)
- https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html (https://web.archive.org/web/20260310192909/https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html)
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf (https://web.archive.org/web/20261115125447/https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)
- https://www.quantexlab.com/en/develop/elm327.html (https://web.archive.org/web/20261115124900/https://www.quantexlab.com/en/develop/elm327.html)
- https://www.quantexlab.com/en/develop/elm327_hsfz.html (https://web.archive.org/web/20260519001549/https://quantexlab.com/en/develop/elm327_hsfz.html)
- https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf (https://web.archive.org/web/20261115130551/https://www.scantool.net/scantool/downloads/682/obdlink_frpm_f.pdf)

No snapshot found:

- https://archive.org/download/BMWTechnicalTrainingDocuments/ST042%20E65%20Complete%20Vehicle%20%28Part%201%29/03_E65%20Bus%20Systems.pdf
- https://archive.org/download/BMWTechnicalTrainingDocuments/ST811%20F01%20Complete%20Vehicle/03.1_F01%20Bus%20Systems.pdf
- https://bimmerworld.com/Foxwell-20-Pin-Round-Port-Adapter-for-1987-2000-BMW.html
- https://dzid26.github.io/opendbc-BMW-E8x-E9x
- https://github.com/dzid26/opendbc-BMW-E8x-E9x
- https://github.com/emdzej/ediabasx
- https://github.com/emdzej/ediabasx-docs-sgbd
- https://github.com/pazi88/ds2
- https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols
- https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/message/IMLSGRPCPG53OQ7I36WI3XIPTD7E6SOH/
- https://www.bimmerforums.com/forum/showthread.php?p=19053287
- https://www.mvwautotechniek.nl/en/bmw-ista-list-of-control-units-and-legend
- https://www.spoolstreet.com/threads/e9x-bench-setup.6469

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://dzid26.github.io/opendbc-BMW-E8x-E9x
