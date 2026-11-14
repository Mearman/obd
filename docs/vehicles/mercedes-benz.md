# Mercedes-Benz and smart: reading vehicles through the OBD-II port with an ELM327 or STN adapter

Mercedes-Benz diagnostics split into three families: K-line cars reached through a 38-pin round socket or an old 16-pin socket, CAN cars where the 16-pin OBD-II socket reaches a central gateway and, behind it, KWP2000 over ISO-TP on CAN-C and CAN-B, and later UDS cars (with DoIP on some recent platforms) where a generic adapter sees little beyond emissions data. An ELM327 or STN adapter speaks the right physical layers for the K-line and CAN cases, but only on the pins and buses the OBD-II socket exposes, so the open-source tool can realistically cover powertrain and gateway-reachable modules on the CAN-era cars (the W211 profile and its siblings) and nothing on FlexRay, MOST or DoIP-only cars. Everything beyond a few well-sourced facts here is community knowledge from reverse engineering projects and forums, not Mercedes documentation, and is tagged "unconfirmed" where a source was thin. Coding, flashing, SCN coding, security access and actuator tests are out of scope for a read-only tool and are mentioned only to say so.

Scope note: this document extends the existing W211 profile (CAN-C 500 kbit/s, KWP2000 over ISO-TP, session start `10 92`, identification `1A 86`, codes `18 02 FF 00`) and does not repeat it.

## What the OBD-II socket and the gateway actually expose

The generic OBD-II 16-pin socket puts CAN high on pin 6, CAN low on pin 14, K-line on pin 7, signal ground on 5, chassis ground on 4 and battery positive on 16, with pins 1, 3, 8, 9 and 11 left to the manufacturer ([Mohseninia, Open source vehicle ECU diagnostics and testing platform, ch. 2](https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)). On W204 and W212 cars, sources agree that pins 6 and 14 carry CAN ([MBWorld W204 thread](https://mbworld.org/forums/c-class-w204/786701-obd-port-not-working.html?nojs=1)). A forum post on W204 says that CAN goes straight to the central gateway in the front SAM; this is a forum claim and is unconfirmed as Mercedes documentation.

The central gateway (CGW, ZGW in the open CAN databases) routes between CAN-C (powertrain, reported at 500 kbit/s) and CAN-B (interior), and the diagnostic link runs from the CGW to the telematics or head-unit side on W211 ([youcanic overview](https://www.youcanic.com/mercedes-benz-central-gateway-control-module-failure/), [MBWorld W221 thread](https://mbworld.org/forums/s-class-w221/795905-w221-can-bus-thread-3.html)). A practical consequence documented in the OpenVehicleDiag thesis: on a W203 test rig the instrument cluster answered diagnostic requests only on CAN-B and not on CAN-C, and the gateway (in a real car, the ignition switch ECU, according to the thesis) is what relays between them ([Mohseninia thesis, section 3.1](https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)). So an adapter on the OBD socket normally reaches CAN-B modules only because the gateway forwards ISO-TP diagnostic frames, and that forwarding is the gateway's decision.

Speeds: CAN-C is consistently reported at 500 kbit/s. CAN-B is reported at 83.3 kbit/s on W203/W209/W211-era cars ([MBWorld W211 CAN B thread](https://mbworld.org/forums/audio-electronics/580108-w211-can-b-hacking-10.html), [rnd-ash W203-canbus](https://github.com/rnd-ash/W203-canbus), thesis log showing baud 83333), but other sources give 125 or 250 kbit/s for other cars ([MBWorld W204 CAN thread](https://mbworld.org/forums/c-class-w204/699204-need-canbus-obd-2-details.html), search summary only), so a CAN-B speed for any chassis other than W203/W209/W211 is unconfirmed. An OBD socket adapter does not tap CAN-B directly in any case: reading raw CAN-B means wiring to the interior bus (the W203-canbus project wires CAN-B at the X30/7 hub under the dash and CAN-C behind the cluster, and warns that CAN-B timing needs a 16 MHz CAN controller clock), which is out of scope here.

MOST (fibre optic multimedia ring) and FlexRay (chassis and driver-assistance on the later cars) are not on the OBD socket pins. A German workshop article states that only XENTRY reads the W222 FlexRay segment fully and that generic OBD tools do not see it ([kfz-dietrich W222](https://kfz-dietrich.com/blog/mercedes-diagnose-w222-s-klasse-typische-probleme/)); I found no source confirming FlexRay on W164 or W221 (unconfirmed, searched and absent).

## Chassis and era map

| Family | Typical chassis | Socket and physical layer | Reachable with an ELM327/STN |
|---|---|---|---|
| K-line, round socket | W124, W140, W201, W202, W210, R129, R170, W208, G-Class up to the early 2000s | 38-pin round socket, K-line diagnostics per module ([model list](https://www.youcanic.com/mercedes-benz-models-with-38-pin-port/)); some also carry a 16-pin OBD socket for the engine only | Only through a 38-pin adapter that maps the K-line to pin 7; wiring unconfirmed, see below |
| K-line, old 16-pin | Some W124 and W202 | Non-standard 16-pin, pin 8 reported as K-line for HFM-SFI petrol engines ([pinouts.ru](https://pinouts.ru/CarElectronics/mercedes_old_16pin.shtml), seen in a search summary only) | Unconfirmed |
| CAN-C KWP2000 | W203, W209, W211, W219, W220, W163 and similar ([rnd-ash W203-canbus](https://github.com/rnd-ash/W203-canbus) lists W203, W209, W211, W219) | 16-pin OBD-II, CAN on pins 6 and 14, gateway behind it | Powertrain and gateway-reachable modules; ISO 15765 with Mercedes IDs |
| CAN-C plus UDS | W204, W212, W221, W164, W251 and later | 16-pin OBD-II, CAN on pins 6 and 14, central gateway | Unconfirmed per chassis; see the KWP2000 section for what is known |
| DoIP-era | W222 reported, W213 facelift and later reported | 16-pin with Ethernet on pins 3, 11, 12, 13 and activation on pin 8 | Not reachable with an ELM327 or STN: it has no Ethernet |

Which exact chassis moved from KWP2000 to UDS is unconfirmed: I found no primary source stating the switch-over point. The OpenVehicleDiag thesis states that DAS with CBF files is used for pre-2008 cars and Xentry with SMR-D for later ones, which suggests the data-format boundary but is not a protocol-by-chassis table.

### The 38-pin round socket and the 16-pin adapter

Round-socket cars are listed on [youcanic's model reference](https://www.youcanic.com/mercedes-benz-models-with-38-pin-port/); that page's dates are internally inconsistent, so verify per VIN. A 38-pin to 16-pin adapter listing for W210 maps 38-pin pin 1 to the 16-pin grounds, pin 3 to 16-pin pin 16 (+12 V) and pin 4 to 16-pin pin 7 (K-line) ([search summary of a W210 cable listing](https://www.desertcart.nz/products/50218569)). This is a vendor listing seen only through a search summary, so treat the pin mapping as unconfirmed and check it against a W202 or W210 wiring diagram. Note that the commonly repeated "pin 3 and pin 8" shorthand for the old sockets did not survive checking: pin 3 was power in the one adapter mapping found, and pin 8 appears only on the old 16-pin connector.

K-line modules on such cars use ISO 9141-2 or ISO 14230 (KWP2000 on K-line), which the ELM327 supports as protocols 3, 4 and 5, with slow init on 3 and 4 and fast init on 5 ([Quantex ELM327 notes](https://de1.quantexlab.com/en/develop/elm327.html)). The OpenVehicleDiag thesis states Mercedes K-line is 10.4 kbit/s with either wake-up method. Two limits follow: the ELM327 talks to one K-line on pin 7 and has no multiplexer, while Mercedes round-socket cars have a separate K-line per module on the 38-pin socket, so an adapter that routes one module to pin 7 at a time is needed (unconfirmed which products select which module). Whether a clone ELM327 implements the K-line protocols at all is also doubtful: the thesis notes that cheap clones usually support only part of the chip's protocol set.

## Mercedes KWP2000 on CAN: sessions and services

KWP2000 on CAN needs no wake-up and is normally paired with ISO 15765 transport ([Wikipedia: Keyword Protocol 2000](https://en.wikipedia.org/wiki/Keyword_Protocol_2000)). The Mercedes specifics in the open sources:

- Session start: the OpenVehicleDiag scanner probes each ISO-TP endpoint with `10 92` to decide it speaks KWP2000 and `10 03` to decide it speaks UDS, treating a rejection as "not supported" ([thesis, section 3.5](https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)). So `10 92` is accepted as the KWP2000 session start on the ECUs that scanner met (what the sub-function means is unconfirmed); the full set of Mercedes session identifiers (flash, development, supplier sessions) is unconfirmed in any open source I could read. Starting anything other than the diagnostic session the profile already uses is out of scope for a read-only tool.
- Service set: the thesis appendix C.3 lists the KWP2000 services it implements: `10` StartDiagnosticSession, `11` ECUReset, `14` ClearDiagnosticInformation, `17` ReadStatusOfDTC, `18` ReadDTCByStatus, `1A` ReadECUIdentification, `21` ReadDataByLocalIdentifier, `22` ReadDataByIdentifier, `23` ReadMemoryByAddress, `27` SecurityAccess, `28` and `29` normal message transmission control, `2C`, `2E`, `30` InputOutputControlByLocalIdentifier, `31` to `33` routine control, `34` to `37` transfer, `3B`, `3D`, `3E` TesterPresent, and `83` to `87` timing and link control. For a read-only tool only `10`, `18`, `17`, `1A`, `21` and `22`, `23` (memory reads are risky and best left out) and `3E` matter. `14`, `11`, `27`, `28`, `2E`, `2C`, `30` to `3D` and the transfer services change state and are out of scope. The mapping from KWP to UDS equivalents is in the same table.
- TesterPresent addressing: some CAN-B ECUs expect TesterPresent on a separate global address from their request ID, which the thesis models as an optional "global send id" and reports as needed for the interior CAN-B devices on its W203 rig. In the open W211 CAN-B database the global request frame is 0x1C ([can_spec_canb.txt](https://raw.githubusercontent.com/rnd-ash/mb-w211-pc/main/can_spec_canb.txt)).
- Response pending and timing: UDS defines NRC 0x78 "response pending" ([Wikipedia: UDS](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services)); Mercedes KWP2000 ECUs are reported to use the same mechanism (unconfirmed, inferred from the shared lineage).

### UDS and later cars

UDS (ISO 14229) evolved from KWP2000 and runs over CAN, FlexRay, K-line and Ethernet ([Wikipedia: UDS](https://en.wikipedia.org/wiki/Unified_Diagnostic_Services)). One community guide says Mercedes does not use the standard 0x7DF to 0x7E7 arbitration IDs for UDS ([Xplatforms/mercedes-hacking-docs, chapter 1](https://github.com/Xplatforms/mercedes-hacking-docs/blob/master/Chapter%201%20Vehicle%20Bus%20Protocols%20and%20Diagnostics.md)); that conflicts with the W211 engine at 0x7E0/0x7E8 already in the profile, so it is at best chassis-specific and is unconfirmed. I found no readable open table of per-ECU CAN IDs for W204, W212 or W221 (unconfirmed, searched and absent); the practical method is the one the OpenVehicleDiag scanner uses, probing request IDs and checking for ISO-TP replies, which is only safe at low rates and with session-start frames the ECU rejects harmlessly.

## CAN ID conventions in the open projects

The two best open CAN descriptions are the W211 specification files in [rnd-ash/mb-w211-pc](https://github.com/rnd-ash/mb-w211-pc): [can_spec_canc.txt](https://github.com/rnd-ash/mb-w211-pc/blob/main/can_spec_canc.txt) and [can_spec_canb.txt](https://github.com/rnd-ash/mb-w211-pc/blob/main/can_spec_canb.txt), plus `w211_can_def_c/` and `can_e.dbc`. Both are DBC-like text with per-ECU frame blocks, and both include KWP2000-over-ISO-TP diagnostic request (`D_RQ_*`) and response (`D_RS_*`) frames, system-diagnostic (`SD_RS_*`) status frames and network management (`NM_*`) frames. The convention that emerges:

- CAN-C diagnostic responses sit in the 0x7xx range for the engine and transmission (engine 0x7E8, transmission 0x7E9, ESP 0x785, EHB 0x79B) and in the 0x4xx range for some add-on units (distance radar 0x4A0). Only the response IDs are listed for CAN-C, not the request IDs (read from the spec file, file truncated at the read limit).
- CAN-B diagnostic IDs are in the 0x4xx to 0x5xx range, with separate request and response IDs per module: for example EZS request 0x4E0 and response 0x5FF, instrument cluster request 0x5B4 and response 0x4F4, front, rear and driver SAM responses at 0x4E1 to 0x4E3, and AAG response 0x4F0. These are the W211 values; other chassis differ (unconfirmed, the specs are W211-only, although [W203-canbus](https://github.com/rnd-ash/W203-canbus) says W203 and W209 share much of it).
- ECU abbreviations are German: MS or ME engine, GS or EGS transmission, ESP or BS brake, EZS ignition switch, KOMBI cluster, SAM signal acquisition module, ZGW central gateway, AGW audio gateway, DTR distance radar. Several frames are defined under more than one ECU, so a database lookup by ID can be ambiguous.

[dvjcodec/Mercedes-Benz-CAN-BUS](https://github.com/dvjcodec/Mercedes-Benz-CAN-BUS) (W203 and W210, cluster-focused) and [rnd-ash/W203-canbus](https://github.com/rnd-ash/W203-canbus) (an Arduino instrument-cluster project with its own reverse-engineering spreadsheet) are useful for bus wiring and cluster behaviour, but I could not read either project's ID tables.

## Tooling and data formats

- DAS and Xentry: DAS is the older workshop suite for pre-2008 cars and uses CBF description files; Xentry is the later suite and uses SMR-D ([Mohseninia thesis, section 2.4.3](https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)). One blog describes the relationship differently, so the exact hand-over is unconfirmed ([OBDExpress](https://blog.obdexpress.co.uk/2018/10/15/xentry-vs-das-whats-the-difference/), search summary only). Both start by reading the VIN and deriving the ECU list from it, then scan each ECU with its own protocol.
- Vediamo and DTS Monaco: engineering tools (variant coding, parameter access) fed by the same data. One forum guide says Vediamo uses CBF files while DTS Monaco uses SMR-D, and calls SMR-D a newer CBF plus DLL; this is a forum claim and unconfirmed ([mbsdconnect4 blog](https://mbsdconnect4.blogspot.com/2019/03/benz-w215-2003-diagnosis-with-dts-or-vediamo.html), search summary only). These tools write to ECUs and are out of scope.
- ODX: ISO 22901 / ASAM MCD-2D diagnostic data exchange, with categories ODX-D (diagnostic data), ODX-C (communication parameters), ODX-V (vehicle topology), ODX-F (flash), ODX-E (coding) and ODX-FD (function mapping) ([Mohseninia thesis, section 2.5](https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)). Softing's DTS lists the compact runtime formats SOD (editable, exportable to ODX), SRD (monolithic) and SMR (modular), and says they are far smaller than ODX ([Softing DTS](https://automotive.softing.com/products/softing-dts.html)).
- CBF: Daimler's proprietary container, which holds ECU variants, communication parameters, request payloads, fault code lists with descriptions and the data interpretation rules, per the thesis. It also embeds SCN coding data that the OpenVehicleDiag parser deliberately does not extract.
- Open projects: [CaesarSuite](https://github.com/jglim/CaesarSuite) (MIT, parses CBF and CFF, reverse engineered from a proprietary library, with Diogenes for variant coding and Trafo to JSON), [OpenVehicleDiag](https://github.com/rnd-ash/OpenVehicleDiag) (GPL-3.0 Rust diagnostic platform with J2534 and SocketCAN, a CBFParser that converts Mercedes CBF to JSON, its SMR parser removed after a DMCA notice), and [openStar](https://github.com/rnd-ash/openStar) (DAS/Xentry-style Rust application that needs the user's own Xentry install, is described by its README as non-functional, and forbids attaching Xentry files to issues). The user-facing rule from openStar applies here: do not redistribute or ask contributors to attach DAS, Xentry, CBF or SMR-D files. This document links no data dumps for the same reason, and its sources are projects and datasheets only.
- Interfaces: Mercedes tooling targets J2534 pass-through or its own SDconnect multiplexer, not ELM327. The thesis comparison marks J2534 as "No" for ELM327 and the Bosch VCI as "Yes". A read-only open tool that wants Mercedes-wide coverage through an ELM327 will therefore reimplement what DAS does for each chassis from reverse-engineered knowledge.

## What an ELM327 or STN can and cannot do

Can:

- Open ISO 15765 (protocols 6 to C) at 500 kbit/s on pins 6 and 14, set an 11-bit request ID with `AT SH`, restrict the response with `AT CRA`, and receive multi-frame ISO-TP replies, with automatic flow control by default (`AT FC` mode 0) ([Quantex ELM327 notes](https://de1.quantexlab.com/en/develop/elm327.html)).
- Send raw KWP2000 service requests to Mercedes ECUs on those IDs, because the chip does not interpret service bytes once the protocol is set. This is how the existing W211 profile works.
- Talk ISO 9141-2 or ISO 14230-4 K-line on pin 7 (protocols 3 to 5), with slow init on 3 and 4 and fast init on 5, subject to genuine hardware (Quantex notes above, thesis on clones).

Cannot, or only with workarounds:

- Reach CAN-B or other buses not wired to the OBD socket, MOST, FlexRay or the Ethernet DoIP bus; the gateway decides what it forwards, and CAN-B reachability through the gateway is not guaranteed on every chassis (unconfirmed per chassis).
- Reach round-socket K-line modules directly: only one K-line, no module multiplexing, and the 38-pin mapping must be built into the cable or adapter.
- Use extended CAN addressing for long payloads: the ELM327 sends the target address in the first data byte (`AT CEA`) and warns that with eight data bytes and extended addressing "data bytes may be lost" (Quantex notes above). Mercedes KWP2000 on CAN in the open specs uses plain 11-bit IDs, so this mainly matters for BMW-style addressing, not Mercedes (inferred, unconfirmed on other chassis).
- Set a custom flow control frame in mode 0: the tester's flow control uses the request/response ID pair the chip derives, so ECUs that need a different flow control ID, block size or separation time need `AT FC SM 1`, `AT FC SH` and `AT FC SD` ([Quantex notes](https://de1.quantexlab.com/en/develop/elm327.html)). STN chips are described as having an improved flow-control mechanism and larger messages than the ELM327 ([OBD Solutions STN1110](https://www.obdsol.com/stn1110/), search summary only); I could not read the datasheet text to confirm the details, so which Mercedes ECUs actually need STN is unconfirmed.
- Sniff both buses at once, run two diagnostic sessions in parallel or hold a high-rate bus load: the chip is a single-channel interpreter.
- Do DoIP: the Ethernet activation line is on OBD pin 8, with two pin layouts for the Ethernet pairs (pins 3 and 11 or 1 and 9 for receive, 12 and 13 for transmit), 100BASE-TX, and a tester senses the activation resistance to choose between them ([python-doipclient automotive Ethernet primer](https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html)). The thesis lists a similar but not identical layout with pin 8 as "Ethernet wake up". Neither is a Mercedes document.

## Newer cars: gateway filtering and DoIP

A DoIP-capable J2534 vendor documents routing activation types, including a default diagnostic type, a WWH-OBD type limited to emissions-regulated data, and a "central security" type that gives extended access through the security gateway ([Quantex DoIP pass-thru notes](https://de2.quantexlab.com/en/develop/j2534/pt_ioctl_doip.html), search summary only). Mercedes-Benz Trucks' pass-through documentation notes that its tested DoIP adapters are for XENTRY Pass Thru use only ([MB Trucks XPTEU FAQ](https://service-info-int.mercedes-benz-trucks.com/media/wysiwyg/XPTEU/FAQ_XPTEU_EN.pdf), search summary only). Which chassis use DoIP is disputed between sources: one reseller lists W204, W212, W222 and pre-facelift W213 as CAN or K-line and the facelift W213, W214 and W223 as mixed DoIP and CAN FD ([eLinehub](https://elinehub-website.pages.dev/mercedes-benz-doip-remote-diagnostics-programming/)), while a tool vendor says the W222 uses DoIP ([VXDIAG](https://vxdiag.com/collections/vcx-se/products/vxdiag-vcx-se-for-mercedes-benz)). Both are commercial pages, so the chassis boundary is unconfirmed. What is safe to say for the tool: on a car whose OBD socket has the Ethernet pins populated, the ELM327-style CAN path may expose only emissions-related or gateway-filtered data, and the tool should detect an empty or refusing gateway and report it rather than retry. A search summary mentioned a newer secured gateway that blocks OBD communication with the ECU in a flashing context; I could not trace the original page, so it is unconfirmed.

## Gateway filtering and wake-up frames (community guide)

The community guide [Xplatforms/mercedes-hacking-docs](https://github.com/Xplatforms/mercedes-hacking-docs) (chapters [1](https://github.com/Xplatforms/mercedes-hacking-docs/blob/master/Chapter%201%20Vehicle%20Bus%20Protocols%20and%20Diagnostics.md) and [3](https://github.com/Xplatforms/mercedes-hacking-docs/blob/master/Chapter%203%20Connecting%20to%20the%20Vehicle.md)) makes three claims worth designing around, all community material and unconfirmed against Mercedes documentation:

- The OBD-II port is filtered by the EIZ/EZS or a SAM module: reads of traffic from the networks are allowed, but only diagnostic CAN IDs are accepted for writing, and ordinary IDs sent through the port are rejected. For a read-only tool this means only diagnostic request IDs will ever get through, which matches the design.
- Sleeping modules need a model-specific wake-up frame before they answer. The guide lists a broadcast frame carrying `02 10 92 00 00 00 00 00` (a KWP2000 session start in an ISO-TP single frame, the same `10 92` the W211 profile uses) on ID 0x001C for W169, W203, W209, W211, W215 and W245, on 0x04E4 for W164, W240 and W251, and on 0x0692 for W216 and W221. This agrees with the 0x1C global request frame in the open W211 CAN-B specification above. The table is crowd-sourced, so treat IDs for chassis other than W211 as leads to verify.
- It names four networks: M-CAN powertrain and chassis (CAN-C, high speed), I-CAN interior (CAN-B, low speed), a diagnostic D-CAN described as high speed with a proprietary Mercedes protocol, and MOST. The D-CAN name matches the diagnosis CAN mentioned in other forum posts; its pin assignment at the socket is unconfirmed.

A cross-check from a trade article (["XENTRY and OBD II Go Deep"](https://automotivetechinfo.com/wp-content/uploads/2019/01/XENTRY-and-OBD-II-Go-Deep.pdf), opened as a PDF this time) says an ELM327 or ELM329-class tool has "minimal access" to engine and transmission networks on a Mercedes, with data limited to what regulation requires, that full-network tools need a multiplexer talking to the Central Gateway, and that DoIP access is a newer problem for such tools. That article is about the later cars and does not give per-chassis boundaries.

An ELM327 does not send periodic keep-alive messages on CAN ([ELM327 datasheet text, page 59](https://www.libble.eu/elm-327/online-manual-727154/?page=0060)), so a tool that needs a non-default session held open must send `3E` itself on a timer. On K-line the chip sends its own wakeup message by default after three seconds of silence (`C1 33 F1 3E` for KWP), which is not necessarily the right keep-alive for a Mercedes module.

## Recommendations for the tool

- Keep the Mercedes profile per chassis, not per brand, with a source-tagged ID table and an explicit "unconfirmed" flag where the IDs came from a different chassis (W211 values on W203 or W209 are plausible and unconfirmed).
- Probe sparingly: use `10 92` or `3E`-style benign requests to check an endpoint, never `27`, `2E`, `31` or the transfer services, and stop on any negative response other than the expected "not supported".
- Report gateway behaviour as data: no response on CAN-B IDs may mean a missing module, a gateway that does not forward, or a wrong bus speed; do not retry aggressively.
- For K-line cars, require an explicit adapter capability flag (module select) rather than guessing the 38-pin wiring.
- Document that smart (fortwo, forfour and Roadster) models were not covered by any source I could read; a smart-specific section would need its own research (unconfirmed, searched and absent).

## Sources I relied on

- OpenVehicleDiag thesis: https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf
- rnd-ash projects: https://github.com/rnd-ash/mb-w211-pc, https://github.com/rnd-ash/OpenVehicleDiag, https://github.com/rnd-ash/openStar, https://github.com/rnd-ash/W203-canbus
- CaesarSuite: https://github.com/jglim/CaesarSuite
- ELM327 behaviour notes: https://de1.quantexlab.com/en/develop/elm327.html
- Softing DTS: https://automotive.softing.com/products/softing-dts.html
- Wikipedia: https://en.wikipedia.org/wiki/Keyword_Protocol_2000 and https://en.wikipedia.org/wiki/Unified_Diagnostic_Services
- DoIP pinout: https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- https://automotive.softing.com/products/softing-dts.html (http://web.archive.org/web/20260517063535/https://automotive.softing.com/products/softing-dts.html)
- https://automotivetechinfo.com/wp-content/uploads/2019/01/XENTRY-and-OBD-II-Go-Deep.pdf (http://web.archive.org/web/20240805234008/https://automotivetechinfo.com/wp-content/uploads/2019/01/XENTRY-and-OBD-II-Go-Deep.pdf)
- https://blog.obdexpress.co.uk/2018/10/15/xentry-vs-das-whats-the-difference/ (http://web.archive.org/web/20260413041522/http://blog.obdexpress.co.uk/2018/10/15/xentry-vs-das-whats-the-difference/)
- https://en.wikipedia.org/wiki/Keyword_Protocol_2000 (http://web.archive.org/web/20261030032840/https://en.wikipedia.org/wiki/Keyword_Protocol_2000)
- https://github.com/dvjcodec/Mercedes-Benz-CAN-BUS (http://web.archive.org/web/20241024032156/https://github.com/dvjcodec/Mercedes-Benz-CAN-BUS)
- https://github.com/jglim/CaesarSuite (http://web.archive.org/web/20251018202702/https://github.com/jglim/CaesarSuite)
- https://github.com/rnd-ash/OpenVehicleDiag (http://web.archive.org/web/20260109122309/https://github.com/rnd-ash/OpenVehicleDiag)
- https://github.com/rnd-ash/W203-canbus (http://web.archive.org/web/20260730111248/https://github.com/rnd-ash/W203-canbus)
- https://github.com/rnd-ash/mb-w211-pc (http://web.archive.org/web/20260730111630/https://github.com/rnd-ash/mb-w211-pc)
- https://github.com/rnd-ash/openStar (http://web.archive.org/web/20221003215921/https://github.com/rnd-ash/openStar)
- https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf (http://web.archive.org/web/20261113213234/https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf)
- https://pinouts.ru/CarElectronics/mercedes_old_16pin.shtml (http://web.archive.org/web/20260822205551/https://pinouts.ru/CarElectronics/mercedes_old_16pin.shtml)
- https://vxdiag.com/collections/vcx-se/products/vxdiag-vcx-se-for-mercedes-benz (http://web.archive.org/web/20251014221637/https://vxdiag.com/collections/vcx-se/products/vxdiag-vcx-se-for-mercedes-benz)
- https://www.obdsol.com/stn1110/ (http://web.archive.org/web/20140510172031/http://www.obdsol.com:80/stn1110/)
- https://www.youcanic.com/mercedes-benz-central-gateway-control-module-failure/ (http://web.archive.org/web/20260810165536/https://www.youcanic.com/mercedes-benz-central-gateway-control-module-failure/)

No snapshot found:

- https://automotive.softing.com/products/softing-dts.html
-
- https://de1.quantexlab.com/en/develop/elm327.html
- https://de1.quantexlab.com/en/develop/elm327.html
-
- https://de2.quantexlab.com/en/develop/j2534/pt_ioctl_doip.html
- https://elinehub-website.pages.dev/mercedes-benz-doip-remote-diagnostics-programming/
- https://en.wikipedia.org/wiki/Unified_Diagnostic_Services
- https://en.wikipedia.org/wiki/Unified_Diagnostic_Services
-
- https://github.com/Xplatforms/mercedes-hacking-docs
- https://github.com/Xplatforms/mercedes-hacking-docs/blob/master/Chapter%201%20Vehicle%20Bus%20Protocols%20and%20Diagnostics.md
- https://github.com/Xplatforms/mercedes-hacking-docs/blob/master/Chapter%203%20Connecting%20to%20the%20Vehicle.md
- https://github.com/jglim/CaesarSuite
-
- https://github.com/rnd-ash/W203-canbus
-
- https://github.com/rnd-ash/mb-w211-pc/blob/main/can_spec_canb.txt
- https://github.com/rnd-ash/mb-w211-pc/blob/main/can_spec_canc.txt
- https://hps.vi4io.org/_media/research/theses/ashcon_mohseninia_open_source_vehicle_ecu_diagnostics_and_testing_platform.pdf
-
- https://kfz-dietrich.com/blog/mercedes-diagnose-w222-s-klasse-typische-probleme/
- https://mbsdconnect4.blogspot.com/2019/03/benz-w215-2003-diagnosis-with-dts-or-vediamo.html
- https://mbworld.org/forums/audio-electronics/580108-w211-can-b-hacking-10.html
- https://mbworld.org/forums/c-class-w204/699204-need-canbus-obd-2-details.html
- https://mbworld.org/forums/c-class-w204/786701-obd-port-not-working.html?nojs=1
- https://mbworld.org/forums/s-class-w221/795905-w221-can-bus-thread-3.html
- https://python-doipclient.readthedocs.io/en/latest/automotive_ethernet.html
- https://raw.githubusercontent.com/rnd-ash/mb-w211-pc/main/can_spec_canb.txt
- https://service-info-int.mercedes-benz-trucks.com/media/wysiwyg/XPTEU/FAQ_XPTEU_EN.pdf
- https://www.desertcart.nz/products/50218569
- https://www.libble.eu/elm-327/online-manual-727154/?page=0060
- https://www.youcanic.com/mercedes-benz-models-with-38-pin-port/
