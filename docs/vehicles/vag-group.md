# Talking to Volkswagen Group vehicles through the OBD-II port

Volkswagen Group cars (VW, Audi, SEAT, Skoda, Porsche, Bentley) speak four generations of manufacturer diagnostics behind the same 16-pin connector: KWP1281 on a K-line (address-word wake-up at 5 baud), KWP2000 on the K-line, KWP2000 carried over CAN inside VW's proprietary TP 2.0 transport, and UDS (ISO 14229) over ISO-TP on later CAN cars, with DoIP on the newest Ethernet-equipped platforms. Generic OBD-II (emissions) is a separate, shallow layer that an ELM327/STN adapter handles natively, but anything beyond the engine's emissions data (fault codes in the ABS or cluster, measuring blocks, identification) needs the manufacturer protocol for the car's era. An ELM327/STN adapter can reasonably cover the ISO-TP/UDS era (it is just ISO 15765 with custom headers), is a poor and mostly unsupported fit for TP 2.0, and cannot do KWP1281 at all in practice, which needs a K-line interface that exposes the line bit by bit or implements the protocol in firmware. On cars from about model year 2020 a diagnostic protection layer (SFD, with a diagnostic firewall and filter in the gateway) sits in front of the modules, but Ross-Tech states reading fault codes, identification and measuring values is not blocked ([Ross-Tech wiki, SFD](https://wiki.ross-tech.com/wiki/index.php/SFD)). Anything that writes (coding, adaptation, basic settings, output tests, security access, flashing) is out of scope for a read-only tool and is mentioned below only to mark the boundary.

## Conventions used in this document

Statements with a URL were read at that URL. Statements tagged "unconfirmed" are inference or recollection with the reason given. Community reverse-engineering write-ups are named as such, because Volkswagen's own specifications are not public: the TP 2.0 author says his page was worked out from presentations and logs, not official documentation ([jazdw.net TP 2.0](https://jazdw.net/tp20)).

## Era map

| Era (approximate)                             | Physical layer                                       | Protocol                                                      | Notes                                                          |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Early 1990s to roughly the early 2000s        | K-line (ISO 9141 physical layer), per-module wake-up | KWP1281 (also called KW1281, standardised later as SAE J2818) | Module addressed by a one-byte address word sent at 5 baud     |
| Late 1990s to mid 2000s                       | K-line                                               | KWP2000 (ISO 14230)                                           | Same wake-up family; same address words                        |
| Early 2000s to mid 2010s                      | CAN (ISO 11898) via the gateway                      | KWP2000 messages inside TP 2.0 (VW's transport, SAE J2819)    | Not ISO-TP; a channel is opened per module                     |
| Mid 2000s onward, dominant on 2010s platforms | CAN                                                  | UDS (ISO 14229) over ISO-TP (ISO 15765-2)                     | Per-module CAN ID pairs; Ross-Tech calls these UDS/ODX modules |
| Newest platforms                              | Automotive Ethernet on the OBD connector             | UDS over DoIP (ISO 13400)                                     | Needs an Ethernet-capable interface                            |

The era boundaries are approximate and overlap by platform: a single car can carry modules on different protocols. Ross-Tech notes that mid-2010 and later Golf-family cars use UDS protocol rear-door modules as slaves of the front-door addresses ([Ross-Tech wiki, Golf/Golf Plus 5K](https://wiki.ross-tech.com/wiki/index.php/VW_Golf/Golf_Plus_%285K/52%29)), and that Ross-Tech's own tooling treats UDS/ODX modules as a distinct class that does not support traditional measuring blocks or adaptation channel numbers ([Ross-Tech wiki, Control Module Maps](https://wiki.ross-tech.com/wiki/index.php/Control_Module_Maps)). The year ranges in the table are unconfirmed: no source read states exact model-year cut-offs, and they differ by model and market.

## Module addressing (the "address word")

VAG tooling addresses each control module by a one-byte hexadecimal logical address, the same number Ross-Tech shows as the controller number and which corresponds to the number used by VAG-1551/1552 tools ([Ross-Tech VCDS-Lite manual](https://www.ross-tech.com/vcds-lite/manual/select.html)). A Ross-Tech wiki vehicle page for the Golf VII lists, among others: 01 Engine, 02 Auto Trans (DSG), 03 ABS Brakes, 05 Access/Start Authorization, 08 Auto HVAC, 09 Central Electronics, 15 Airbags, 16 Steering Wheel, 17 Instrument Cluster, 19 CAN Gateway, 2B Steering Column Lock, 42 Door Electronics Driver, 44 Steering Assist, 52 Door Electronics Passenger, 55 Headlight Aim Control, 5F Information Electronics, 75 Telematics and A9 Structure-Borne Sound ([Ross-Tech wiki, VW Golf VII](<https://wiki.ross-tech.com/wiki/index.php/VW_Golf_VII_(5G/AU)>)). The same address means the same function across platforms in general, but the set of modules present varies per car (unconfirmed as a universal rule: only the Golf VII page was read).

Addresses are hexadecimal, not decimal: a KW1281 forum thread records the cluster address being 17 hex, not decimal 17, as the cause of a failed init ([blafusel.de forum](https://www.blafusel.de/phpbb/viewtopic.php?p=1662)).

Address 19 is the gateway. On gateway-equipped cars it is the module that routes diagnostics from the OBD connector to the other buses and it is central to the diagnostic filter and SFD behaviour described below ([Ross-Tech wiki, SFD](https://wiki.ross-tech.com/wiki/index.php/SFD)).

## K-line era: KWP1281

### Wake-up (slow, or 5-baud, init)

The tester sends the module address at 5 baud, 7 data bits, odd parity, one stop bit, least significant bit first; each bit lasts about 200 ms. The module then sends a sync byte 0x55 so the tester can measure its baud rate, followed by two keyword bytes (the example read shows 0x01 and 0x8A) and the tester answers with the complement of the second keyword (0x75). After wake-up the data rate is typically 4800, 9600 or 10400 baud at 8N1, and the author of the source suggests trying each in turn ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html), a German hobbyist page the author himself marks as partly unverified and outdated).

A second source corroborates the sync byte and the 10400 nominal rate, and notes that a PC bit-banging the 5-baud address through a "dumb" cable has timing problems and reliable sync detection needs a microsecond-precision timer ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md)).

VCDS has a "Start Baud" option, the first baud rate it will try, defaulting to automatic detection ([Ross-Tech VCDS options](https://ross-tech.com/vcds/tour/option_screen.php)), which is consistent with the rate not being fixed per module.

### Block structure and the complement acknowledgement

Each block is: length, block counter, block title, data bytes, end byte 0x03. The length counts every byte except the end byte, the counter increments with every block and wraps from 0xFF to 0x00, and each byte except the end byte is acknowledged by the receiver sending back its bitwise complement (0xFF minus the byte). Tester and module take turns, and the interface echoes the tester's own bytes ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html)). A transcript from a firmware-based tool shows the same shape and a block of title 0x09 acting as the acknowledgement block ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md), where the framing is inferred from the transcript by the page reader and not stated by the author).

Timing is empirical: a pause of about 5 ms before each transmitted byte avoided errors, and too long a silence makes the module drop the session; the author's "under 500 ms" figure is an estimate ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html)). The vwradio author says modules typically expect around 1 ms between bytes of a block ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md)). The two figures differ, so treat per-byte timing as something to tune against real hardware (unconfirmed which is right for which module).

### Block titles relevant to a read-only tool

From the blafusel page: 0x07 get fault codes, answered by 0xFC blocks; 0x29 group reading request, answered by 0xE7; 0xF6 ASCII data (the identification blocks sent straight after init: VAG part number, component name, software version, dealer code); 0x09 acknowledge, which must be sent regularly to keep the session alive when there is nothing else to send; 0x06 end of session. 0x05 (clear fault codes) is a write and out of scope ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html)). The vwradio transcript shows the same 0xF6, 0x09, 0x29 and 0xE7 titles ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md)).

### Cable requirements

KWP1281 needs a K-line interface (a "KKL" cable is the common name: an FTDI-style USB serial chip plus a K-line level shifter) driven by software that can do the 5-baud wake-up and then the 8N1 block exchange with correct per-byte timing; the vwradio author argues dumb cables cause init and timing trouble and built a microcontroller-based, galvanically isolated interface that also offers a pass-through mode for software written for dumb cables ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md)). Whether a given FTDI-based KKL clone works is a hardware-and-driver question not settled by any source read here (unconfirmed).

## K-line era: KWP2000 (ISO 14230)

KWP2000's K-line uses the ISO 9141 physical layer, and wake-up is either a 5-baud address or a fast initialisation, both timing-critical; the same application protocol also runs over CAN with ISO 15765 transport ([Wikipedia, Keyword Protocol 2000](https://en.wikipedia.org/wiki/Keyword_Protocol_2000)). In VCDS, KWP2000 modules still offer classic measuring blocks, some engine controllers offer a faster "Turbo" sampling button, and a third-party summary describes measuring blocks as parameters of readDataByLocalIdentifier (the latter is a search-result summary of a project note, unconfirmed at source) ([Ross-Tech VCDS tour, measuring blocks](https://mail.register.ross-tech.com/vcds/tour/m-blocks.php)). Fault codes on KWP2000 and CAN modules can carry freeze frame data; see the fault code section.

Which VAG module speaks KWP1281 and which speaks KWP2000 is per module and per car, not per year (unconfirmed as a rule; no source read gives a table). A robust tool tries the era's protocol and falls back.

## CAN era with TP 2.0

TP 2.0 is VW's transport protocol for KWP2000 over CAN, published as SAE J2819 ([SAE J2819](https://saemobilus.sae.org/standards/j2819_200802-tp20-vehicle-diagnostic-protocol), paywalled; the listing was not read in full). The best open description is a reverse-engineered write-up ([jazdw.net TP 2.0](https://jazdw.net/tp20)), summarised here:

- Channel setup is a 7-byte frame sent on CAN ID 0x200 to the gateway base; the module answers on 0x200 plus its logical address (0x201 for the engine at 0x01). Opcodes seen: request 0xC0, positive response 0xD0, negative responses 0xD6 to 0xD8. The request tells the module which CAN ID the tester will listen on and which to transmit on; observed practice is the tester asking the module to use IDs in the 0x300 to 0x310 range, with modules replying on 0x740. The 0x740 behaviour is observed, not specified. The application type byte is 0x01 (KWP).
- Immediately after setup the tester sends a parameters request (opcode 0xA0 or 0xA1) carrying block size, the ACK timeout T1 (the page says it should exceed four times T3), T3 (inter-packet interval), and T2 and T4 fixed at 0xFF. Timing bytes combine a unit (0.1, 1, 10 or 100 ms) with a multiplier.
- Data packets carry 2 to 8 bytes: the upper nibble of the opcode says whether an ACK is expected and whether it is the last packet, the lower nibble is a sequence number wrapping 0xF to 0x0, and the first packet starts with the total KWP payload length. ACK opcodes are 0xB (ready) and 0x9 (not ready).
- Keep-alive is the channel test (0xA3); break is 0xA4; disconnect is 0xA8, answered with the module's own disconnect.

A separate source says VW gateways do not support multiple open channels at once, so modules are polled one at a time with a channel opened and closed per module ([OVMS developer list thread](https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/thread/FDVRIIZNUR765CESHVMECH73E4DF4EOC/), which says the gateway base ID is normally 0x200 and that VW gateways do not support multiple open channels).

An open implementation exists: PyVCDS implements VWTP 2.0 and KWP2000 (synchronous only), tested on a CANdleLight adapter on Linux SocketCAN, and explicitly does not support ELM327 adapters ([PyVCDS](https://github.com/MartijnD92/PyVCDS)). The Rust crate ecu_diagnostics has a VW TP 2.0 channel ([ecu_diagnostics vwtp.rs](https://docs.rs/crate/ecu_diagnostics/0.107.2/source/src/hardware/vwtp.rs), whose open() does the 0x200 channel setup, an 0xA0/0xA1 parameters exchange, an 0xA3 keep-alive after about one second idle and an 0xA8 disconnect).

## CAN era with UDS over ISO-TP

### Request and response IDs

Later platforms use ISO 15765-2 (ISO-TP) with per-module 11-bit CAN ID pairs. A community wiki on MQB sniffing lists these pairs (request / response): Engine 1 0x7E0 / 0x7E8, Engine 2 0x7E2 / 0x7EA, Transmission 0x7E1 / 0x7E9, All-wheel-drive 0x70F / 0x779, Gateway 0x710 / 0x77A, ABS 0x713 / 0x77D, Dashboard 0x714 / 0x77E, SRS 0x715 / 0x77F, HVAC 0x746 / 0x7B0 ([mr-fix.info wiki, CAN-BUS sniffing](https://wiki.mr-fix.info/index.php?title=CAN-BUS_sniffing)). The page does not say how these map to the logical address words. From the table, the engine and transmission pairs differ by 0x08 (the standard OBD-II ISO 15765-4 pairing) and the others by 0x6A. The 0x6A offset is an inference from the table, not stated on the page; it matches openpilot's firmware query configuration, which applies an rx offset of 0x6a to its SRS, steering, radar and camera group and no offset to engine and transmission ([opendbc volkswagen values.py](https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car/volkswagen/values.py)). An MQB CAN sniffer project lists the cluster at 0x714 replying on 0x77E and reading a DID on it ([MQB-sniffer](https://github.com/mrfixpl/MQB-sniffer), which also lists module 0x02 gearbox on 0x7E1 / 0x7E9 and uses services 0x10 and 0x3E to hold the cluster session). This is the one place a source pairs an address word with CAN IDs: cluster 0x17 with 0x714 / 0x77E, and gearbox 0x02 with 0x7E1 / 0x7E9.

These IDs come from community captures of MQB-platform cars, not from a Volkswagen document. Treat the table as a starting point, per platform (MQB, MLB, PQ and others differ), and verify by probing (unconfirmed for other platforms). The mapping from address word to CAN ID is confirmed by a source only for the cluster (0x17 to 0x714) and gearbox (0x02 to 0x7E1) above; the others (for example 0x19 to 0x710, 0x03 to 0x713) are inferred from the community table's names and are unconfirmed.

The 0x7DF functional request and 0x7E0/0x7E8 physical pair are the ISO 15765-4 OBD-II convention ([DTS tutorial excerpt via search result](https://www.scribd.com/document/676269537/DTS-Manuals), not opened), so generic OBD-II works on these cars as on any other.

### Services for read-only work

UDS defines DiagnosticSessionControl (0x10), ReadDTCInformation (0x19), ReadDataByIdentifier (0x22) and TesterPresent (0x3E), with positive responses at the service ID plus 0x40 and negative responses as 0x7F, service ID, reason code ([Wikipedia, Unified Diagnostic Services](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services)). Openpilot reads firmware identification from VW ECUs with service 0x22 and three data identifiers including 0xF187 (spare part number), and expects a response beginning 0x62 ([opendbc volkswagen values.py](https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car/volkswagen/values.py)). One user-reported MQB engine parameter set uses 0x22 with three-byte identifiers on header 7E0 (the service byte followed by a 16-bit DID plus a prefix byte as listed in the source) ([mqbcan](https://github.com/jrjoaoramos/mqbcan), via a user forum thread: [leasehackr thread](https://forum.leasehackr.com/t/volkswagen-obd-ii-data-retriving/498843)). Those identifiers are community-found and vary by engine (unconfirmed for other engines).

### Measuring values on UDS modules

Classic numbered measuring-block groups do not exist on UDS/ODX modules: Ross-Tech says the Measuring Blocks function is unavailable for them and Advanced Measuring Values must be used, with a "Group UDS requests" option to speed sampling ([Ross-Tech VCDS tour, advanced measuring blocks](https://mail.register.ross-tech.com/vcds/tour/adv-meas-blocks.php)). Ross-Tech's channel map tooling needs a per-module ROD file to read UDS modules ([Ross-Tech wiki, Control Module Maps](https://wiki.ross-tech.com/wiki/index.php/Control_Module_Maps)). So a read-only tool needs a per-module DID catalogue (ODX or ROD data), which is not freely distributed (unconfirmed whether any open ODX set exists).

## DoIP on the newest platforms

DoIP (ISO 13400) runs UDS over Ethernet. On the OBD connector, the tester asserts an activation line on pin 8 (+5 V) and senses the resistance between pin 8 and pin 5 to identify the pinout; two pinouts are allowed, option 1 using pins 3, 11, 12, 13 and option 2 using pins 1, 9, 12, 13, with pin 8 the activation line in both ([python-doipclient, Automotive Ethernet primer](https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html)). A telematics vendor lists the VW ID.3 among vehicles needing an Ethernet bypass on a 16-pin harness, which supports DoIP on that platform ([Geotab install guide](https://installguides.geotab.com/Guide/DoIP+Ethernet+Bypass+for+16-pin+Harnesses/265), read as a search summary; its pin details are for the vendor's harness). I found no VW-specific source for the edge-node address, routing activation or which pinout option Volkswagen uses (unconfirmed). An ELM327/STN serial adapter cannot speak DoIP at all (inference: its protocols are the serial-bus list below, with no Ethernet); a DoIP tool needs an Ethernet interface and a client such as python-doipclient.

## ELM327 and STN adapters: what works

The ELM327 datasheet lists 12 protocols: 3 ISO 9141-2 (5-baud init, 10.4 kbaud), 4 ISO 14230-4 KWP (5-baud init), 5 ISO 14230-4 KWP (fast init), 6 to 9 ISO 15765-4 CAN (11 or 29 bit, 500 or 250 kbaud), A J1939, and B and C user-defined CAN ([ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)). Relevant controls from the same datasheet:

- ISO side: AT SI performs a slow (5-baud) initiation, AT FI a fast one (protocol 5 only), AT IIA hh sets the slow-init address (the default is 0x33), AT IB 10, 48 or 96 sets the ISO baud rate to 10400, 4800 or 9600, and AT KW0 turns off the keyword check so initiation succeeds with non-standard keywords.
- CAN side: AT CAF0 turns off automatic formatting so the PCI bytes are supplied by the caller; AT SH sets the transmit header; AT CRA sets the receive address filter; AT FC SH, FC SD and FC SM set the flow-control header, data and mode so ISO-TP flow control goes to the right CAN ID. AT SP 6 selects 11-bit 500 kbaud CAN.
- The STN1110 datasheet lists compatibility with the ELM327 command set and adds support for raw CAN (ISO 11898) and non-legislated ISO 15765 ([STN1110 datasheet](https://www.scantool.net/scantool/downloads/313/stn1110_ds_f.pdf), which also says the part is not recommended for new designs).

What follows from that, as inference rather than from a source that tested it:

- UDS over ISO-TP to a given module is workable: set the header to the module's request ID, set the CAN receive address to its response ID, set the flow-control header to the request ID, leave automatic formatting on so the chip builds PCI bytes and reassembles multi-frame replies, and send 0x22 or 0x19 requests. The general pattern (ATSH, ATFCSH, ATCRA with a vendor tester address) is shown on a BMW example, not a VW one ([Quantexlab ELM327 notes](https://www.quantexlab.com/en/develop/elm327.html), via a search summary). No VW-specific recipe with a verified ID table was found (unconfirmed it works on all modules).
- TP 2.0 needs raw CAN: the channel setup uses its own frame format on 0x200, and data transfer uses TP 2.0's own opcodes, sequence numbers and ACKs, which are not ISO 15765 PCI bytes. With CAF0 an ELM327 could in principle send and receive those raw frames and the host could implement TP 2.0 on top, but the receive filtering and per-frame timing are the host's problem (unconfirmed: no source read shows it done). PyVCDS rejects ELM327 outright, citing numerous bugs in raw CAN transport including on clones ([PyVCDS](https://github.com/MartijnD92/PyVCDS)). A forum post says one adapter supports TP 2.0 with ATSH and ATWT commands, but no recipe was read ([torque-bhp forum](https://torque-bhp.com/community/main-forum/vagcom/paged/7), via a search summary).
- KWP1281 does not fit the ELM327: the ISO protocols expect ISO 9141 or ISO 14230 framing and a keyword check, while KWP1281 is a block protocol with a length byte, a block counter, per-byte complement acknowledgements and an end byte. AT KW0, AT IIA and AT IB give a module wake-up at a chosen address and baud rate, but no source read shows an ELM327 completing a KWP1281 session. A forum poster with a 2001 Golf TDI concluded that an ELM chip does not support KWP1281, but the post names the ELM323, not the ELM327, so it is only indirect evidence for the ELM327 ([NI forum thread](https://forums.ni.com/t5/Automotive-and-Embedded-Networks/K-line-On-Board-Diagnostics/td-p/2647335)) and PyVCDS treats K-line as handled by other cheap adapters ([PyVCDS](https://github.com/MartijnD92/PyVCDS)). Treat KWP1281 over an ELM327 as unsupported; use a K-line interface as described above.
- KWP2000 on the K-line: AT SP 4 with AT IIA set to the module address and AT IB for the baud rate is a plausible route to a KWP2000 module (unconfirmed: no source read demonstrates it with a VAG module; Ross-Tech and the vwradio author both use dedicated interfaces).
- A generic OBD-II request to 0x7DF works on these cars, but one MQB user reports very little data returns that way and that VAG modules need their own physical headers ([leasehackr thread](https://forum.leasehackr.com/t/volkswagen-obd-ii-data-retriving/498843)).

## Fault codes and freeze frames

VCDS shows a 4 to 7 digit VAG fault number (the digit count varies on UDS modules), a component identifier and text, and on a second line the generic P-code where one exists; many VAG codes have no OBD-II equivalent ([Ross-Tech VCDS tour, fault codes](https://www.ross-tech.com/vcds/tour/dtc_screen.php)). On KWP1281 the raw record is a two-byte code read as one 16-bit value plus a status byte, up to four faults per 0xFC block ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html)). How the 16-bit value converts to the five-digit VAG number or a P-code is not documented in any source read, so a tool should show the raw value alongside any conversion (unconfirmed).

Freeze frame (VCDS: "Display Freeze Frame Data") exists on KWP2000 and CAN modules, more likely on cars redesigned after 2003, and includes fault priority (0 to 8), fault frequency (0 to 254), a reset counter that counts down per fault-free driving cycle, and timestamps that may be inaccurate because many modules lack a real-time clock; UDS modules can return a variable digit count and VCDS's "aggressive mode" retrieves more faults than factory tools ([Ross-Tech VCDS tour, fault codes](https://www.ross-tech.com/vcds/tour/dtc_screen.php)). VCDS logs also show an eight-bit fault status plus mileage, date, engine speed and load in freeze frames ([vagcode.info sample logs](https://vagcode.info/en/brands/volkswagen/polo/601/log-289.html), via a search summary). The UDS 0x19 sub-function layout and status mask bits are defined by ISO 14229 and were not read here; consult the standard or udsoncan's implementation.

Clearing codes is a write and out of scope.

## Measuring blocks and group reads

On KWP1281 the tester sends block 0x29 with a group number from 1 to 255 and the module returns 0xE7 with four measurements, each a type byte plus two data bytes (A and B); the meaning of the type byte depends on the module and sometimes the group, and the formulas published by the blafusel author are largely unverified ([blafusel.de, KW1281](http://www.blafusel.de/obd/obd2_kw1281.html)). The vwradio transcript is consistent with four three-byte cells per reply ([vwradio kwp1281_tool README](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md)). Group contents are module-specific, so Ross-Tech label files (plain-text descriptions of each group) are the practical source of what a group means ([Ross-Tech VCDS tour, measuring blocks](https://mail.register.ross-tech.com/vcds/tour/m-blocks.php)). The Ross-Tech wiki "Label Files" page returned 404 when fetched, so the label file format itself was not confirmed (unconfirmed).

On KWP2000 modules classic groups still exist; on UDS modules they are replaced by DID-based advanced values, as above.

## Gateway behaviour, SFD and the diagnostic firewall

The Ross-Tech wiki on SFD ([Ross-Tech wiki, SFD](https://wiki.ross-tech.com/wiki/index.php/SFD)) states:

- SFD (Schutz der Fahrzeugdiagnose, protection of vehicle diagnostics) replaces the older login and security access scheme. It began with model year 2020 across Audi, Bentley, Bugatti, CUPRA, MAN, SEAT, Skoda, Volkswagen and Volkswagen Commercial, with rollout varying by model, and one car can mix SFD-protected and classic modules. Porsche is not named on that page (unconfirmed whether Porsche uses the same scheme).
- Read access is not blocked: reading control module IDs, fault codes and measuring values works without an unlock. Coding, adaptation, basic settings and output tests may be restricted. SFD2 extends SFD for cybersecurity and software-update protection and requires digitally signed manufacturer messages for coding, adaptation and updates.
- A diagnostic firewall on older protected cars needs the bonnet opened before full module access (Ross-Tech recommends opening it on model year 2015 and newer cars). A diagnostic filter on newer cars may block access to some modules entirely, and VCDS falls back to a restricted, read-only mode.
- The filter state is readable from measuring values in the gateway (address 19). Disabling the filter and performing an unlock are write-class operations and out of scope.

Implications for a read-only tool, partly inference: expect some modules to be unreachable on gateway-filtered cars even for reads (the wiki says newer cars "may block access to some modules entirely"), so the tool should report "no response" and "filtered" as different outcomes where it can tell them apart, and should not retry aggressively. Whether a filtered module answers with a negative response code or stays silent is not stated in any source read (unconfirmed). One search result (an Autel page) claims secure gateways on 2018 models, which conflicts with the Ross-Tech start of model year 2020, so the start year for a given car should not be assumed ([Autel, security gateways](https://autel.us/?p=44547), not opened).

## Open projects and references

- Ross-Tech wiki: [SFD](https://wiki.ross-tech.com/wiki/index.php/SFD), [Control Module Maps](https://wiki.ross-tech.com/wiki/index.php/Control_Module_Maps), per-model module lists such as [Golf VII](<https://wiki.ross-tech.com/wiki/index.php/VW_Golf_VII_(5G/AU)>); the [VCDS tour pages](https://www.ross-tech.com/vcds/tour/dtc_screen.php) document fault code, measuring block and advanced measuring behaviour. VCDS itself is closed.
- [PyVCDS](https://github.com/MartijnD92/PyVCDS): Python VWTP 2.0 and KWP2000 on SocketCAN, UDS planned, ELM327 unsupported.
- [vwradio kwp1281_tool](https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md): firmware-based KWP1281 interface with a documented transcript.
- [blafusel.de KW1281 page](http://www.blafusel.de/obd/obd2_kw1281.html): German, hobbyist, partly unverified; the most readable block-level description found.
- [jazdw.net TP 2.0](https://jazdw.net/tp20): reverse-engineered TP 2.0 description.
- [ecu_diagnostics (Rust)](https://docs.rs/crate/ecu_diagnostics/0.107.2/source/src/hardware/vwtp.rs): includes a TP 2.0 channel.
- [udsoncan](https://github.com/pylessard/python-udsoncan) (MIT, ISO 14229 in Python) and [python-doipclient](https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html) (DoIP transport for udsoncan), both located by search ([PyPI doipclient](https://pypi.org/project/doipclient/1.1.1/)); neither is VW-specific.
- [opendbc volkswagen values.py](https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car/volkswagen/values.py): a working firmware-query configuration against live VW ECUs.
- [mr-fix.info CAN-BUS sniffing](https://wiki.mr-fix.info/index.php?title=CAN-BUS_sniffing) and [MQB-sniffer](https://github.com/mrfixpl/MQB-sniffer): MQB CAN and UDS ID observations.
- Standards (paywalled, not read): [SAE J2818 (KWP1281)](https://saemobilus.sae.org/content/J2818_201905), [SAE J2819 (TP 2.0)](https://saemobilus.sae.org/standards/j2819_200802-tp20-vehicle-diagnostic-protocol), ISO 14229, ISO 15765, ISO 13400.
- ELM327 and STN: [ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf), [STN1110 datasheet](https://www.scantool.net/scantool/downloads/313/stn1110_ds_f.pdf).

## Implications for `obd-read`

- Probe order by era: generic OBD-II on 0x7DF first; then UDS to the per-module ID pairs; TP 2.0 and KWP1281 only with a backend that has raw CAN or K-line access respectively. An ELM327/STN backend should advertise only generic OBD-II and UDS-over-ISO-TP capability (inference from the sections above).
- Keep the per-module CAN ID table as data keyed by platform, flagged as community-sourced, and let the user override it.
- Report the era and protocol per module in the output, and distinguish "no response", "negative response" and "unsupported by adapter".
- Do not issue any service that changes state: clear codes (KWP1281 0x05, UDS 0x14), session changes beyond default or extended read sessions where avoidable, security access, coding, adaptation, basic settings, output tests, routine control, and any flash or write service are all out of scope.

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- http://www.blafusel.de/obd/obd2_kw1281.html (http://web.archive.org/web/20260825155151/https://www.blafusel.de/obd/obd2_kw1281.html)
- https://en.wikipedia.org/wiki/Keyword_Protocol_2000 (http://web.archive.org/web/20261030032840/https://en.wikipedia.org/wiki/Keyword_Protocol_2000)
- https://forum.leasehackr.com/t/volkswagen-obd-ii-data-retriving/498843 (http://web.archive.org/web/20240909125355/https://forum.leasehackr.com/t/volkswagen-obd-ii-data-retriving/498843)
- https://forums.ni.com/t5/Automotive-and-Embedded-Networks/K-line-On-Board-Diagnostics/td-p/2647335 (http://web.archive.org/web/20151104104402/http://forums.ni.com:80/t5/Automotive-and-Embedded-Networks/K-line-On-Board-Diagnostics/td-p/2647335)
- https://github.com/jrjoaoramos/mqbcan (http://web.archive.org/web/20210109153132/https://github.com/jrjoaoramos/mqbcan)
- https://github.com/mrfixpl/MQB-sniffer (http://web.archive.org/web/20250826131442/https://github.com/mrfixpl/MQB-sniffer)
- https://github.com/pylessard/python-udsoncan (http://web.archive.org/web/20260222140820/https://github.com/pylessard/python-udsoncan)
- https://installguides.geotab.com/Guide/DoIP+Ethernet+Bypass+for+16-pin+Harnesses/265 (http://web.archive.org/web/20260719025113/https://installguides.geotab.com/Guide/DoIP+Ethernet+Bypass+for+16-pin+Harnesses/265)
- https://jazdw.net/tp20 (http://web.archive.org/web/20260202103735/https://jazdw.net/tp20)
- https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/thread/FDVRIIZNUR765CESHVMECH73E4DF4EOC/ (http://web.archive.org/web/20260711233856/https://lists.openvehicles.com/archives/list/ovmsdev@lists.openvehicles.com/thread/FDVRIIZNUR765CESHVMECH73E4DF4EOC/)
- https://ross-tech.com/vcds/tour/option_screen.php (http://web.archive.org/web/20250930142234/https://www.ross-tech.com/vcds/tour/option_screen.php)
- https://saemobilus.sae.org/content/J2818_201905 (http://web.archive.org/web/20240424145420/https://saemobilus.sae.org/content/J2818_201905/)
- https://saemobilus.sae.org/standards/j2819_200802-tp20-vehicle-diagnostic-protocol (http://web.archive.org/web/20260715021601/https://saemobilus.sae.org/standards/j2819_200802-tp20-vehicle-diagnostic-protocol)
- https://wiki.ross-tech.com/wiki/index.php/Control_Module_Maps (http://web.archive.org/web/20260504005754/https://wiki.ross-tech.com/wiki/index.php/Control_Module_Maps)
- https://wiki.ross-tech.com/wiki/index.php/SFD (http://web.archive.org/web/20260504005754/https://wiki.ross-tech.com/wiki/index.php/SFD)
- https://wiki.ross-tech.com/wiki/index.php/VW_Golf/Golf_Plus_%285K/52%29 (http://web.archive.org/web/20250930141848/https://wiki.ross-tech.com/wiki/index.php/VW_Golf/Golf_Plus_(5K/52))
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf (http://web.archive.org/web/20261108174631/https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)
- https://www.quantexlab.com/en/develop/elm327.html (http://web.archive.org/web/20260711113833/https://quantexlab.com/en/develop/elm327.html)
- https://www.ross-tech.com/vcds-lite/manual/select.html (http://web.archive.org/web/20220707113440/https://www.ross-tech.com/vcds-lite/manual/select.html)
- https://www.ross-tech.com/vcds/tour/dtc_screen.php (http://web.archive.org/web/20261028115607/https://www.ross-tech.com/vcds/tour/dtc_screen.php)
- https://www.scantool.net/scantool/downloads/313/stn1110_ds_f.pdf (http://web.archive.org/web/20260325090255/https://www.scantool.net/scantool/downloads/313/stn1110_ds_f.pdf)
- https://www.scribd.com/document/676269537/DTS-Manuals (http://web.archive.org/web/20260218031406/https://www.scribd.com/document/676269537/DTS-Manuals)

No snapshot found:

- https://autel.us/?p=44547
- https://docs.rs/crate/ecu_diagnostics/0.107.2/source/src/hardware/vwtp.rs
- https://en.wikipedia.org/wiki/Unified_Diagnostic_Services
- https://github.com/MartijnD92/PyVCDS
- https://github.com/mnaberez/vwradio/blob/main/kwp1281_tool/README.md
- https://mail.register.ross-tech.com/vcds/tour/adv-meas-blocks.php
- https://mail.register.ross-tech.com/vcds/tour/m-blocks.php
- https://pypi.org/project/doipclient/1.1.1/
- https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html
- https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car/volkswagen/values.py
- https://torque-bhp.com/community/main-forum/vagcom/paged/7
- https://vagcode.info/en/brands/volkswagen/polo/601/log-289.html
- https://wiki.mr-fix.info/index.php?title=CAN-BUS_sniffing
- https://wiki.ross-tech.com/wiki/index.php/VW_Golf_VII_(5G/AU
- https://www.blafusel.de/phpbb/viewtopic.php?p=1662

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://torque-bhp.com/community/main-forum/vagcom/paged/7
- https://wiki.ross-tech.com/wiki/index.php/VW_Golf_VII_(5G/AU
