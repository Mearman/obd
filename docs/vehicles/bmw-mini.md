# BMW and Mini diagnostics through the OBD-II port with an ELM327 or STN adapter

BMW and Mini diagnostics split into three eras with different physical layers. Pre-D-CAN cars use K-line (BMW DS2 framing, later KWP2000), cars from roughly the mid-2000s use CAN with BMW's extended-address ISO-TP style (tester CAN ID 0x6F1, ECU replies on 0x600 plus the ECU address, ECU address as the first data byte), and F-series and newer cars add Ethernet (HSFZ, TCP 6801) through an ENET cable. A stock ELM327 can do the CAN era (user-defined protocol B with ATSH, ATCEA, ATFCSH, ATFCSD, ATFCSM and ATCRA), cannot speak DS2 (it lacks even-parity serial and the framing), and cannot do HSFZ or DoIP unless the adapter firmware implements them (Quantex documents one that does). The standard BMW tooling (EDIABAS, INPA, ISTA, EdiabasLib) describes each ECU in SGBD files (.prg and .grp) and the open projects below document those and the transport layers. Module addresses vary by chassis and bus, so every address in this document is a starting point to verify against the SGBD for the car, never a constant. This document is about reading only: coding, adaptation and flashing are out of scope for `obd-read`.

## Scope and evidence

Claims carry an inline source. Anything inferred, or confirmed only by a single secondary source, is tagged "unconfirmed" with the reason. No primary BMW specification was found, so every wire-level detail comes from reverse-engineering projects, vendor notes or training material and should be checked against captures from the target car.

## Era overview

| Era (approximate) | Physical layer at the OBD port | Application protocol | ELM327 stock firmware |
|---|---|---|---|
| Pre-2000s (round 20-pin connector on many cars) | K-line | DS2 (9600 baud, even parity), some ECUs KWP2000 | No DS2 |
| Late 1990s to mid-2000s (16-pin OBD-II) | K-line on pin 7, sometimes with a second K-line | DS2, KWP2000 (BMW-FAST), ISO 9141 for emissions | Emissions modes only (unconfirmed for BMW-specific services, see below) |
| Mid-2000s onward (E-series with D-CAN) | D-CAN on pins 6 and 14, 500 kbit/s | KWP2000 over CAN or UDS, BMW extended addressing | Yes, via user-defined CAN protocol |
| F-series and newer | D-CAN and Ethernet (ENET cable, pin 8 activation line) | UDS over CAN or HSFZ | CAN only; Ethernet not through an ELM327 |

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

- Tester requests use CAN ID 0x6F1 (0x600 plus tester address 0xF1). ECU replies use 0x600 plus the ECU address (the DME's reply is 0x612). The first data byte carries the other party's address (the ECU address in a request, 0xF1 in a response), followed by the ISO-TP PCI byte and the UDS or KWP payload: https://thesecretingredient.neocities.org/bmw (a reverse-engineering write-up, unconfirmed beyond the DME example it shows).
- Worked example from that page: request `12 03 22 43 00` on 0x6F1, response `F1 05 62 43 00 0D BA` on 0x612, where `22` is ReadDataByIdentifier and `62` is the positive response.
- Quantex's BMW example uses the same scheme with the ECU address on the reply ID: tester 0x6F1, ECU 0x40 replying on 0x640, and ECU 0x10 replying on 0x610: https://www.quantexlab.com/en/develop/elm327.html

### Configuring an ELM327 for it

The Quantex page documents a working sequence, which maps onto the datasheet's user-defined protocol B and extended address commands (https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf):

- `ATPBC101` and `ATSPB` define and select user protocol B as 11-bit, ISO 15765, 500 kbit/s. Whether a stock ELM327 or only the Quantex firmware accepts that exact `PBC` value is not stated, so check the datasheet's protocol B options for the adapter in hand (unconfirmed).
- `ATBI` bypasses the standard OBD initialisation. The page warns it is intended for simulators and demonstrators: https://www.quantexlab.com/en/develop/elm327.html
- `ATSH6F1` sets the request ID. `ATCEA<addr>` sets the extended address byte. `ATCRA6<addr>` restricts receive to the ECU's reply ID.
- Flow control is set by hand: `ATFCSH6F1`, `ATFCSD` with the first byte the ECU address followed by the flow-control PCI (for example `4030FF32`), and `ATFCSM1`. The page says mode 1 only works when the flow-control header and data are already defined.
- `ATCEA` with no argument turns extended addressing off. It is off by default.
- Extended addressing and ISO-TP PCI both consume a data byte, so frames carrying eight data bytes can lose data: https://www.quantexlab.com/en/develop/elm327.html and the datasheet section on CAN extended addresses.
- Quantex reports that a read to one ECU returned NO DATA while another answered, so each target needs its own ATCEA, ATCRA and flow-control data. Mailing-list reports of silence when using 6F1 with extended addressing on an ELM327 clone exist: https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/message/IMLSGRPCPG53OQ7I36WI3XIPTD7E6SOH/ (unconfirmed: a single thread about an unspecified adapter).
- The inferred DME setup is `ATSH6F1`, `ATCEA12`, `ATCRA612` plus flow control to 0x6F1 with first byte 0x12 (unconfirmed: built from the two examples above, not from one source stating it).

Deep OBD states that standard ELM327 adapters work with BMW D-CAN only (March 2007 onward), and that only particular hardware revisions (1.4b, 1.5, original 2.1 on PIC18F25K80 without an MCP2515) are suitable, counterfeit and ARM-based clones often fail: https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html

### Module addresses

BMW addresses are assigned per bus and chassis family, not globally, and no single source read lists them all. Treat the table as unconfirmed starting values and read the real list from the SGBD or from an ECU scan.

| Module | Address | Status |
|---|---|---|
| Tester | 0xF1 | Confirmed by https://thesecretingredient.neocities.org/bmw and https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html |
| DME (engine) | 0x12 | Confirmed as the DME in the write-up above; the F-series list at https://github.com/jokinawa/bmw-f also gives 0x12 for DME2 |
| EGS (gearbox) | 0x18 | Unconfirmed: not found in any page read |
| DSC (stability) | 0x34 | Unconfirmed: the F-series list at https://github.com/jokinawa/bmw-f gives 0x29 for DSC, so the value differs by generation |
| KOMBI (cluster) | 0x60 | Unconfirmed: not found in any page read; the I-Bus address 0x80 for the cluster at https://github.com/piersholt/wilhelm-docs is a different bus |
| ZGM or JBE gateway | not established | Unconfirmed: no address found |
| Functional broadcast over ENET | 0xDF | https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html |

The ISTA control-unit list at https://www.mvwautotechniek.nl/en/bmw-ista-list-of-control-units-and-legend names control units and may help to build a table (not opened for addresses).

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

## Capability summary for obd-read

| Era | Stock ELM327 | STN or other | Notes |
|---|---|---|---|
| DS2 K-line | No (needs even parity and DS2 framing) | Unconfirmed: the STN command reference was not opened | Use a K+DCAN or replacement-firmware route |
| KWP2000 K-line | Standard OBD modes only; BMW services unconfirmed | Unconfirmed | Replacement firmware lists K-line support |
| D-CAN with extended address | Yes with ATSH, ATCEA, ATFCSH, ATFCSD, ATFCSM, ATCRA, on suitable hardware | Unconfirmed | One ECU per configuration; clones often fail |
| Ethernet (HSFZ) | No | Only specific vendor firmware | Use D-CAN, or a direct HSFZ client |
| DoIP | No | Only specific vendor firmware | Mentioned for completeness; no BMW source here ties it to cars |

## Out of scope

Coding, adaptation, programming and flashing (ISTA programming, E-Sys, NCS Expert, SGBD flash variants) are not part of `obd-read`. Read-only services (ReadDataByIdentifier 0x22, ReadDTCInformation 0x19 and the KWP equivalents) are the intended use. This document does not claim these services are safe on every ECU, so a tool should send only what the matching SGBD documents for the target module.

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- https://emdzej.github.io/ediabasx-docs-sgbd (http://web.archive.org/web/20261104192926/https://emdzej.github.io/ediabasx-docs-sgbd/)
- https://emdzej.github.io/ediabasx-docs/ (http://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-analysis.html (http://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-analysis.html)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html (http://web.archive.org/web/20261104192915/https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html)
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html (http://web.archive.org/web/20261104192925/https://emdzej.github.io/ediabasx-docs/reference/interfaces/xenet32-analysis.html)
- https://github.com/jokinawa/bmw-f (http://web.archive.org/web/20200914082941/https://github.com/jokinawa/bmw-f)
- https://github.com/piersholt/wilhelm-docs (http://web.archive.org/web/20260102111000/https://github.com/piersholt/wilhelm-docs)
- https://github.com/piersholt/wilhelm-docs

## (http://web.archive.org/web/20260102111000/https://github.com/piersholt/wilhelm-docs)
- https://github.com/piersholt/wilhelm-docs#ki-bus (http://web.archive.org/web/20260102111000/https://github.com/piersholt/wilhelm-docs)
- https://github.com/uholeschak/ediabaslib (http://web.archive.org/web/20260621070412/https://github.com/uholeschak/ediabaslib)
- https://os.mbed.com/users/openobc/code/e36obd/docs/tip/DS2_8h_source.html (http://web.archive.org/web/20241029173029/https://os.mbed.com/users/openobc/code/e36obd/docs/tip/DS2_8h_source.html)
- https://scapy.readthedocs.io/en/stable/api/scapy.contrib.automotive.bmw.hsfz.html (http://web.archive.org/web/20250215124044/https://scapy.readthedocs.io/en/stable/api/scapy.contrib.automotive.bmw.hsfz.html)
- https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html

### (http://web.archive.org/web/20260310192206/https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html)
- https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html (http://web.archive.org/web/20260615203124/https://uholeschak.github.io/ediabaslib/docs/Deep_OBD_for_BMW_and_VAG.html)
- https://uholeschak.github.io/ediabaslib/docs/Documentation.html (http://web.archive.org/web/20260310185831/https://uholeschak.github.io/ediabaslib/docs/Documentation.html)
- https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html

### (http://web.archive.org/web/20260310192909/https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html)
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf (http://web.archive.org/web/20261108174631/https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)
- https://www.quantexlab.com/en/develop/elm327.html (http://web.archive.org/web/20260711113833/https://quantexlab.com/en/develop/elm327.html)
- https://www.quantexlab.com/en/develop/elm327.html

### (http://web.archive.org/web/20260711113833/https://quantexlab.com/en/develop/elm327.html)
- https://www.quantexlab.com/en/develop/elm327_hsfz.html (http://web.archive.org/web/20260519001549/https://quantexlab.com/en/develop/elm327_hsfz.html)

No snapshot found:

- https://archive.org/download/BMWTechnicalTrainingDocuments/ST042%20E65%20Complete%20Vehicle%20%28Part%201%29/03_E65%20Bus%20Systems.pdf
-
- https://archive.org/download/BMWTechnicalTrainingDocuments/ST811%20F01%20Complete%20Vehicle/03.1_F01%20Bus%20Systems.pdf
- https://bimmerworld.com/Foxwell-20-Pin-Round-Port-Adapter-for-1987-2000-BMW.html
-
- https://dzid26.github.io/opendbc-BMW-E8x-E9x
- https://emdzej.github.io/ediabasx-docs-sgbd
-
- https://emdzej.github.io/ediabasx-docs/reference/interfaces/obd32-protocols.html
-
- https://github.com/dzid26/opendbc-BMW-E8x-E9x
-
- https://github.com/emdzej/ediabasx
-
- https://github.com/emdzej/ediabasx-docs-sgbd
- https://github.com/pazi88/ds2
-
- https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols
-
- https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/message/IMLSGRPCPG53OQ7I36WI3XIPTD7E6SOH/
- https://thesecretingredient.neocities.org/bmw
- https://uholeschak.github.io/ediabaslib/docs/AdapterTypes.html
-
- https://uholeschak.github.io/ediabaslib/docs/ENET_WiFi_Adapter.html
-
- https://uholeschak.github.io/ediabaslib/docs/Replacement_firmware_for_ELM327.html
- https://www.bimmerforums.com/forum/showthread.php?p=19053287
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
-
- https://www.mvwautotechniek.nl/en/bmw-ista-list-of-control-units-and-legend
- https://www.quantexlab.com/en/develop/elm327.html
-
- https://www.quantexlab.com/en/develop/elm327_hsfz.html
-
- https://www.spoolstreet.com/threads/e9x-bench-setup.6469

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://dzid26.github.io/opendbc-BMW-E8x-E9x
