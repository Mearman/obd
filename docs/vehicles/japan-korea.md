# Japanese and Korean vehicles over OBD-II with an ELM327/STN-style adapter

Japanese and Korean cars split into three tiers for a read-only tool built on an ELM327 or STN adapter. Standard SAE J1979 emissions data works on every make over whichever of ISO 9141-2, ISO 14230-4 (KWP2000) or ISO 15765-4 (CAN) the car uses, and the ELM327 handles all three. Manufacturer-specific data on CAN cars (Toyota and Hyundai/Kia hybrid and EV battery data, Mazda mode 22 PIDs, Nissan Leaf battery) is reachable by setting a per-module request header and sending mode 21 or 22 requests, and the best documentation is community PID lists rather than manufacturer documents. Older K-line cars with proprietary diagnostic protocols (Subaru SSM1/SSM2, Nissan Consult I and II, Mitsubishi MUT, Honda's own diagnostic link) generally cannot be read by an unmodified ELM327 in their native protocol: they need a cable or interface that speaks the make's protocol, and several open projects document those. Almost everything below the standard layer is community-documented and car-specific, so every header, PID and formula must be treated as a hypothesis to verify on the target car, and the tool should only ever send read services. Coding, adaptation and flashing are out of scope throughout.

## Scope and conventions

- The tool is read-only: standard modes 01, 02, 03, 07, 09 and 0A, plus manufacturer read services (mode 21, mode 22, UDS 0x22 ReadDataByIdentifier, KWP 0x21 ReadDataByLocalIdentifier). Anything that writes, clears, adapts, codes, actuates or flashes is out of scope, as are security-access sessions.
- "Unconfirmed" below means the claim rests on a single forum post, a secondary summary, or my own inference, with the reason given.
- Where a source is a forum thread or a shared spreadsheet it is community reverse engineering, not a manufacturer specification.

## What an ELM327 or STN adapter can do

- The ELM327 supports ISO 9141-2 (5 baud init, 10.4 kbaud), ISO 14230-4 KWP with either 5 baud or fast initiation, SAE J1850 PWM and VPW, and ISO 15765-4 CAN at 11 or 29 bit and 250 or 500 kbaud, with protocol selection by `AT SP` ([ELM327 datasheet](https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf)).
- It can set the header bytes for K-line and CAN requests, so a CAN request can be addressed to a specific module rather than the broadcast address; the same datasheet documents the header, filter and flow-control commands (`AT SH`, `AT CRA`, `AT FC...`), and [Quantexlab's ELM327 notes](https://www.quantexlab.com/en/develop/elm327.html) show worked examples (BMW, not a Japanese or Korean make).
- The K-line baud rate is limited to what the datasheet allows: the 10.4 kbaud default can be adjusted, but the chip is an OBD-II interface, not a general UART ([ELM327 datasheet](https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf)). Subaru SSM runs at 4800 baud and SSM1 at 1953 baud, so a stock ELM327 cannot be a native SSM interface; a RomRaider developer notes that ELM327 chips are routinely reflashed for SSM K-line ([RomRaider forum](https://www.romraider.com/forum/viewtopic.php?p=147617)). Treat any claim of SSM through an unmodified ELM327 as unconfirmed.
- Cheap clones often implement only part of the command set or have faulty firmware. Forum users on both the Leaf and Prius communities report clones failing on the car-specific work ([leaf-obd tutorial](https://leaf-obd.readthedocs.io/en/latest/tutorial/elm327.html), [Priuschat](https://www.priuschat.com/goto/post?id=1754304)).
- Header handling matters to a polling tool: some apps switch to the custom PID's header and then no longer poll standard PIDs alongside ([RaceChrono forum](https://racechrono.com/forum/discussion/comment/10804/)). A tool should reset the header (`AT SH` back to the functional address) between standard and module-specific requests.
- STN-based adapters (OBDLink) add features beyond the ELM327 command set; OBDLink states that its MX+ has add-ons for Honda/Acura and Hyundai/Kia ([OBDLink support](https://support.obdlink.com/support/solutions/articles/43000711154)). What those add-ons do at protocol level is unconfirmed: the page is vendor material and the result I saw did not describe the wire behaviour.
- A module only answers on its physical address in some cars and manufacturers are not obliged to allow physical addressing of requests, which is a reason an OEM PID can fail on a car even with the right ID ([write-up on a 2019 RAV4 Hybrid](https://scithings.id.au/OBD_PID.pdf)).

## Protocol by era

K-line (ISO 9141-2, ISO 14230-4) is on pin 7, with pin 15 as the optional L-line; pins 6 and 14 connected means the car uses CAN instead ([SparkFun OBD-II primer](https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols), [muki01 K-line library](https://awesome.ecosyste.ms/projects/github.com%2Fmuki01%2Fobd2_kline_library)). ISO 14230-4 was mostly found on Asian vehicles from the early 2000s (one source says from 2003, another 2003 to 2008) ([obdplanet](https://obdplanet.com/obd2-protocol)). The changeover was model-specific rather than a single year: a Toyota pinout reference lists ISO 9141 or ISO 9141-2 for many 2000 to 2009 Yaris, Corolla, Echo and Sienna entries, both ISO 14230-4 and ISO 9141-2 for some Tundra and Previa entries, and CAN for a 2007 FJ Cruiser ([pinouts.ru Toyota/Lexus](https://pinouts.ru/CarElectronics/Toyota_lexus_obd2_diagnostic.shtml)). CAN has been mandatory on cars sold in the US from the 2008 model year (general OBD-II knowledge, not checked against a source this session; unconfirmed for other markets).

The tool should therefore never infer the protocol from make and year: probe with automatic protocol search (`AT SP 0`), record which protocol the adapter reports, and treat the result as authoritative for that car.

## Toyota and Lexus

- **K-line era.** The pinout reference above shows K-line on pin 7 for most models after 1998 and J1850 on earlier ones. Toyota's own diagnostic tool is Techstream, running on an Intelligent Tester or an equivalent interface; that tool's initialisation details are not documented in anything I opened, so the keyword bytes and ECU address for Toyota K-line enhanced data are unconfirmed.
- **CAN era.** Standard emissions data uses the usual 0x7DF functional request and 0x7E0 engine ECU request, with responses from 0x7E8 upward (general ISO 15765-4 convention; a [r/CarHacking post](https://reddit.ny4.dev/r/carhacking) uses the same pair).
- **Hybrid battery and inverter data.** Toyota hybrid data is read with mode 21 or 22 requests to named modules, with the header selecting the module. Reports from the Prius community: Gen 2 and PHV PIDs use mode 21 with header 7E2 (for example the battery current PID 218A), Gen 4 reports mode 21 returning "mode not supported" and suggests mode 22 with two-byte PIDs, one Gen 4 user read hybrid battery SOC from header 747, and others point to 7D2 for the hybrid ECU and 7E3 for HV battery PIDs ([Priuschat Gen2 thread](https://www.priuschat.com/goto/post?id=1754304), [Priuschat Gen IV thread](https://www.priuschat.com/goto/post?id=2489140), [Priuschat Gen III thread](https://www.priuschat.com/goto/post?id=2241649)). These conflict by generation and are single-user reports, so the header and service for each model are unconfirmed until tested on that car.
- **Gen 2 Prius reference.** [Tetsuji Oguchi's Gen 2 Prius PID document](https://oguchi-rd.com/Accomplishment/Automobile/07%20Toyota%20Prius/Parameter%20IDs/Toyota%20Gen%202%20Prius%20PIDs.pdf) (read in full as text) is written for Torque Pro on 2004 to 2009 Prius and separates unsolicited broadcast values, generic solicited CAN requests to ECU 07E0, and Prius-specific solicited requests: mode 21 PIDs to 07E2 (hybrid control, for example the drive condition ID and stop light switch 21D3) and to 07E3 (the HV battery ECU, for example HV battery state of charge as 21CE and 21D0), which contradicts the single-user report above that places HV battery PIDs on 7E2 for this generation.
- **Torque files.** The Priuschat threads above are the main source of Torque extended-PID CSV files for Gen 2, Gen 3, Gen 4 and PHV Prius, and a Corolla hybrid thread exists ([Priuschat](https://priuschat.com/posts/3582276)). Torque takes the CSV in its `extendedpids` folder on the phone ([Priuschat](https://www.priuschat.com/goto/post?id=1754304)). A Corolla owner reports that powertrain changes make older lists unreliable on newer cars ([Priuschat](https://priuschat.com/posts/3582276)).
- **Newer Toyotas and free apps.** A write-up on a 2019 RAV4 Hybrid found that a cheap ELM-based adapter with Torque, Car Scanner ELM and OBD Now Terminal could not read OEM PIDs and suggests Techstream is needed ([write-up](https://scithings.id.au/OBD_PID.pdf)). Whether an STN adapter fixes that is unconfirmed.
- **Other module headers.** I did not find a source that confirms Toyota ABS, body or SRS request IDs (7B0, 7C0 and similar are commonly quoted but I could not verify them), so the tool should discover addressable modules rather than hard-code them.
- **Car Scanner** has a Toyota CAN connection profile and a user reports using it on a Land Cruiser 150 ([ih8mud thread](https://forum.ih8mud.com/threads/custom-pid-for-1kd-ftv-injector-feedback-car-scanner-torque.1384815/)).

## Honda and Acura

- **Pinout.** A Honda pinout reference lists K-line on pin 7 (ISO 9141-2 and ISO 14230-4) and pin 9 as the Service Check System line, not a K-line; it lists ISO 9141 for roughly 1996 to 2006, a mix for 2006 to 2008 and CAN from 2008 ([evoscan Honda pinout via search summary](https://www.evoscan.com/technical-vehicle-manuals/107); the page failed to load when fetched, so this is unconfirmed from a single source). The "pin-specific K-line" idea, that Honda's own diagnostic tool uses a different line than the generic one, could not be confirmed from any source I opened.
- **Gateway behaviour.** A forum discussion of a seventh-generation Accord describes two K-line connections, one to the engine ECU following the standard approach and one to a proprietary gateway (the MICU) that Honda's HDS can read but some ELM327 units cannot; forum users conclude generic readers do not get beyond engine data on those cars ([Honda-Tech](https://honda-tech.com/forums/sitemap/t-3366115.html); forum opinion, unconfirmed).
- **Engine data works.** A project reads live engine data from a 2007 Civic Si with an ELM327 USB adapter and pyobd ([Hackster](https://www.hackster.io/jvarner4/obd-ii-information-logger-and-diagnostics-reader-952dd9)). A bridge that translates Honda's own OBD protocol into ELM327 output exists as [ArduinoHondaOBD](https://www.scribd.com/document/902944802/GitHub-AutotronicCommunity-ArduinoHondaOBD) (a Scribd copy of a GitHub README; I did not open the repository).
- **CAN era.** AiM's logger documentation describes the 2006 to 2011 Civic as offering a standard CAN-based diagnostic protocol through the OBD-II port ([AiM Civic 2006-2011](https://aim-sportline.com/download/ecu/stock/honda/Honda_CivicUSA_2006-2011_eng.pdf)); whether ABS and SRS answer a generic request there is unconfirmed (no source found).
- **HDS.** Honda's diagnostic function list shows ABS and SRS as separate functions ([HONDA diagnostic function list](https://cdn.shopify.com/s/files/1/0085/7699/1298/files/HONDA_V01.20_Diagnostic_Function_List_FULL.pdf)). I found no open documentation of HDS's K-line framing, so a read-only tool should treat anything beyond standard emissions as unavailable on K-line Hondas.
- **Hybrids.** I found no Honda hybrid battery PID source I could open; unconfirmed.

### Shipped profile: `honda-acura-29bit`

The profile [`src/profiles/honda-acura-29bit.json`](../../src/profiles/honda-acura-29bit.json) ships 18 unconfirmed address pairs on 29-bit CAN at 500 kbit/s (ELM327 protocol 7, `ATCP18` then `ATSH` with the low three bytes), service 22 in the default session. A unit's request is `18DAxxF1` and its reply comes from `18DAF1xx`. It carries addresses only: OBDb and opendbc are open projects whose signal definitions are not copied, so no data identifier is shipped.

- **OBDb** ([Honda Civic signal set](https://github.com/OBDb/Honda-Civic/blob/main/signalsets/v3/default.json), [archived](https://web.archive.org/web/20261115134434/https://github.com/OBDb/Honda-Civic/blob/main/signalsets/v3/default.json); [Honda CR-V](https://github.com/OBDb/Honda-CR-V/blob/main/signalsets/v3/default.json), [archived](https://web.archive.org/web/20261115134522/https://github.com/OBDb/Honda-CR-V/blob/main/signalsets/v3/default.json); CC-BY-SA-4.0) lists headers `DA01`, `DA0E`, `DA10`, `DA11`, `DA1D`, `DA1E`, `DA26`, `DA28`, `DA2A`, `DA30`, `DA53` and `DA60` with replies from the matching last byte. The other Honda and Acura repositories read (Accord, Accord Hybrid, Clarity, Fit, Insight, Pilot, Ridgeline, ZR-V, Acura Integra, RDX and TLX) were not archived. Its schema never says `DAxx` means `18DAxxF1`.
- **opendbc** ([Honda fingerprints](https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/fingerprints.py), [archived](https://web.archive.org/web/20261115134702/https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/fingerprints.py); [values](https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/values.py), [archived](https://web.archive.org/web/20261115135151/https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/values.py); MIT) uses the full `0x18daxxf1` form with service 22 for steering `30`, SRS `53`, VSA `28`, transmission `1E`, shift-by-wire `0B`, electric brake booster `2B`, head-up display `61`, gateway `EF`, forward radar `B0` and forward camera `B5`, and probes the engine `10` and combination meter `60` as extra units. That is what settles the OBDb header form.
- **Where they disagree.** OBDb types `DA28` and `DA2A` as ABS where opendbc has only `28` (as VSA); OBDb has `0E`, `11`, `1D`, `26`, `2A` and `01` that opendbc does not; opendbc has `0B`, `2B`, `61`, `EF`, `B0` and `B5` that OBDb does not. Both appear in the profile with the source that has them. Left out: OBDb `DBEF` rows (no reply identifier) and `DA15` and `DA16` (one Clarity repository).
- **European fitment.** Both projects describe mostly North American and Japanese cars. opendbc also lists a European CR-V and a diesel Civic, but a UK Honda may place units differently or behind a gateway that does not pass the 29-bit scheme to the OBD-II socket. opendbc queries from a device wired into the car, not the socket, and its own comments say the forward camera cannot be queried in parallel and `18DAB0F1` often fails to answer. Every row stays unconfirmed until `obd-read probe` shows it answering on a car.

## Nissan and Infiniti

- **Consult generations.** Roughly 1989 to 2001 cars use Consult I (DDL1, separate Tx and Rx lines, often a 14-pin round connector), roughly 2002 to 2008 use Consult II (DDL2, K-line) and 2009 onwards use Consult III (CAN); exceptions exist, and one vehicle can mix protocols across ECUs, for example a 2007 350Z with CAN to the engine ECU and body module but K-line to the rest ([NisScan](https://nisscan.com/which-nds-software/)).
- **ELM327 and Consult I.** Forum users state an ELM327 cannot be used with Consult I software and that a dedicated cable with the 14-pin plug (or a 16-pin plug on later cars still using Consult I for the engine) is needed; one V41 Quest owner uses Consult I over the OBD-II plug ([NisScan forum](https://nisscan.com/phpBB3/viewtopic.php?p=981)). For CAN-era cars, NDS III is built to work with ELM327-based adapters ([NisScan NDS III](https://nisscan.com/product/nds-iii-android-app/)). The consequence for a read-only tool: standard OBD-II data from a Nissan is available through the ELM327; Consult engine data on pre-2009 cars is not, without a Consult interface.
- **Open Consult projects.** [OpenConsult](https://github.com/jonsim/openconsult) is a GPLv3 C++ library and command-line tool for Consult I only (about 1989 to 2000, tested on an S14 and R34), needing a 14-pin Consult I USB interface; it is early-stage and states it is not recommended for other people's cars. [K11Consult](https://relatedrepos.com/gh/fridlington/K11Consult) is a Python pyserial interface, an Arduino Consult library exists ([Arduino forum](https://forum.arduino.cc/t/nissan-consult-and-arduino/232484)), and [nissanecu.miraheze.org](https://nissanecu.miraheze.org) covers Consult II ECU reverse engineering. Forum reports quote 9600 baud and an initialisation string of FF FF EF for some ECUs and other values (FF FF ED, FF FF E7) for others ([search summary of forum posts](https://forum.arduino.cc/t/nissan-consult-and-arduino/232484)); no primary specification was found, so both are unconfirmed and OpenConsult's source is the place to verify.
- **Leaf (and e-NV200).** The Leaf does not implement the emissions PIDs, so a plain J1979 scan returns little. The [Nissan Leaf OBD-II manual](https://leaf-obd.readthedocs.io/en/latest/pid/index.html) documents broadcast frames on the Car-CAN bus (ISO 15765-4, 11 bit, 500 kbaud, pins 6 and 14), for example 0x5B3 (state of health and GIDs: SoH in byte B bits 7:1, stored energy in byte F at 80 Wh per count) and 0x358 (turn signal), read with `AT CRA` filters and `AT MA` monitoring on an ELM327 ([5B3 page](https://leaf-obd.readthedocs.io/en/latest/pid/5b3.html), [ELM327 tutorial](https://leaf-obd.readthedocs.io/en/latest/tutorial/elm327.html)). Frames vary between models, so the manual's single worked example (a 2013 ZE0) does not generalise without checking.
- **Battery controller queries.** A community leaf-bus reference lists the battery controller (LBC) as request ID 0x79B and response 0x7BB, and a forum log shows multi-frame replies on 7BB ([leaf_can_bus_messages](https://github.com/NJbubo/leaf_can_bus_messages), whose active-polling table I read and which says module availability varies by model year; [My Nissan Leaf forum](https://mynissanleaf.com/viewtopic.php?p=586558)). Decoding is error-prone: one thread reports nonsensical pack-health values from raw 79B/7BB frames. LeafSpy is the practical reference for what the data should read; the SoH formulas on one blog ([industrialmonitordirect](https://industrialmonitordirect.com/blogs/knowledgebase/diagnosing-nissan-leaf-4th-capacity-bar-drop-soh-and-soc-analysis)) are a low-authority source and unconfirmed.
- **Buses on the Leaf.** On the ZE0 the OBD-II port reaches Car-CAN, EV-CAN is on pins 12 and 13 and AV-CAN on pins 3 and 11 ([leaf-obd tutorial](https://leaf-obd.readthedocs.io/en/latest/tutorial/elm327.html)); on the ZE1, [OVMS](https://docs.openvehicles.com/en/latest/components/vehicle_nissanleaf/docs/index.html) says the OBD-II port cannot be used because the CAN gateway powers down with the ignition off, so a tap behind the cluster is needed.

## Mazda

- **Mode 22 PIDs.** For the MX-5 NC, custom mode 22 PIDs on header 7E0 (brake pressure switch, accelerator pedal position, steering angle) are reported on a RaceChrono forum thread that credits miata.net ([RaceChrono](https://racechrono.com/forum/discussion/comment/11271)). TPMS on the ND is reported on header 720 with PIDs 2A05 to 2A08 (pressure) and 2A0A to 2A0D (temperature), with one user unable to get it working and another recommending an OBDLink MX or MX+ ([mx5-nd-forum.de](https://mx5-nd-forum.de/forum/thread/7187-tpms-data-through-obd-ecu)); a Torque preset uses header 726 for left-front tyre pressure (same thread). All are single-source and unconfirmed per car.
- **Mazda3 and others.** I found no verified Mazda3 PID list; a gist lists mode 22 PIDs on 7E0 without naming a car ([gist](https://gist.github.com/agronick/4d01cfe7f94dd41eeeb46f5e5dd204b8)), so it cannot be applied safely. Mazda's body modules sit partly on a slower bus (MS-CAN) that a plain ELM327 cannot reach; I found no source I could open, so this is unconfirmed.
- Treat 7E0 as a starting guess to test, not a confirmed Mazda value.

### Shipped profile: `mazda-skyactiv`

The profile [`src/profiles/mazda-skyactiv.json`](../../src/profiles/mazda-skyactiv.json) ships 16 unconfirmed address pairs on 11-bit CAN at 500 kbit/s, service 22 in the default session, addresses only.

- **OBDb** ([Mazda 3](https://github.com/OBDb/Mazda-3/blob/main/signalsets/v3/default.json), [archived](https://web.archive.org/web/20261115134154/https://github.com/OBDb/Mazda-3/blob/main/signalsets/v3/default.json); [CX-5](https://github.com/OBDb/Mazda-CX-5/blob/main/signalsets/v3/default.json), [archived](https://web.archive.org/web/20261115134243/https://github.com/OBDb/Mazda-CX-5/blob/main/signalsets/v3/default.json); CC-BY-SA-4.0) gives header and reply pairs `7E0`/`7E8` (engine), `7E1`/`7E9` (transmission), `700`/`708`, `720`/`728`, `726`/`72E`, `750`/`758`, `760`/`768`, `761`/`769`, `793`/`79B`, `7B0`/`7B8`, `7B3`/`7BB`, `7C0`/`7C8` and `7D0`/`7DA`, typing only the engine and transmission. The CX-30, CX-50, CX-60 and MX-5 repositories were read but not archived.
- **opendbc** ([Mazda fingerprints](https://github.com/commaai/opendbc/blob/master/opendbc/car/mazda/fingerprints.py), [archived](https://web.archive.org/web/20261115135011/https://github.com/commaai/opendbc/blob/master/opendbc/car/mazda/fingerprints.py); MIT) names steering `730`, engine `7E0`, forward radar `764`, ABS `760`, forward camera `706` and transmission `7E1` for the CX-5, CX-9, Mazda3 and Mazda6, with the reply at the request plus 8.
- **Where they disagree.** The archived OBDb files have no `730`, `764` or `706`, so the steering unit, radar and camera rest on opendbc alone with the reply inferred as request plus 8 (OBDb's CX-60 repository gives `730`/`738`). OBDb's `7D0` replies from `7DA`, not `7D8`, and OBDb also lists `7D2` replying from the same `7DA`, which one profile cannot hold twice, so `7D2` is left out with the other rows seen only in the CX-30, CX-50 and CX-60 repositories. Neither source names the Mazda2 or CX-3. Mazda's body modules may sit on a slower bus a plain adapter on the socket does not reach, so some rows may stay silent.

## Subaru

- **SSM1, SSM2.** RomRaider's wiki describes the original Select Monitor as an ISO 9141-style serial interface at 4800 baud, 8 data bits, no parity, 1 stop bit ([RomRaider SSM protocol](https://www.romraider.com/index.php/RomRaider/SsmProtocol), read directly: ISO 9141 interface, 4800 bps, 8 data bits, no parity, 1 stop bit). [LibSSM2](https://github.com/src0x/LibSSM2) (GPL-3.0, C#) says SSM2 runs at 4800 baud, older cars use SSM1 at 1953 baud, and it implements eight of the ten well-known SSM2 packet types; the "from 2001" boundary carries a question mark in its own text.
- **Tools.** [RomRaider](https://www.romraider.com/) logger (select the SSM K-line protocol, point it at a logger definitions folder) and [FreeSSM](https://github.com/Comer352L/FreeSSM) (Qt, engine and transmission control units, 1999 onwards, J2534 interface mentioned) are the open implementations; RomRaider's logger definitions hold the parameter-to-address mappings ([HP Academy setup guide](https://www.hpacademy.com/es/foro/ajuste-de-inyeccion-electronica-de-combustible/show/setting-up-rom-raider/), [SubaruDefs](https://github.com/eatinginternet/SubaruDefs)). A third-party blog reports FreeSSM and the RomRaider logger working over a KKL/VAG-COM cable on K-line cars ([obdii365](https://blog.obdii365.com/2019/06/25/subaru-freessm-can-work-kkl-vag-com-cables/); vendor blog, unconfirmed). FreeSSM's README does not say whether it covers SSM1, SSM2 or SSM over CAN.
- **SSM over CAN.** RomRaider forum posts describe a single-byte read as an A8 request sent to CAN ID 0x7E0 inside an ISO-TP single frame, with the ECU answering on 0x7E8 and the response service ID OR 0x40, the ECU also broadcasting on 0x600, and SSM-III service routines resembling mode 22 ([RomRaider forum](https://www.romraider.com/forum/viewtopic.php?p=147617), [another thread](https://www.romraider.com/forum/viewtopic.php?p=147609)). A developer notes that CAN SSM is a different message format from OBD-II on CAN ([RomRaider forum](https://www.romraider.com/forum/viewtopic.php?p=151518)). Users with an OBDLink MX+ report no data from 7E0 queries for CVT values and a developer notes some ECUs (including 2015 and later WRX and a Hitachi ECU) are not supported by the logger over SSM ([RomRaider forum](https://www.romraider.com/forum/viewtopic.php?p=165956), [here](https://www.romraider.com/forum/viewtopic.php?p=161735)). Because the A8 service is not a standard OBD-II service, a stock ELM327 may reject or mangle it: unconfirmed, no thread I opened shows it working.
- **For a read-only tool.** J1979 mode 01 works on the CAN cars (one user reads the ECU ID that way on a 2015 Impreza when SSM-CAN fails, per the forum above). Native SSM needs either a K-line interface that speaks 4800 baud or a CAN stack that can send the A8 read; SSM write and flash services must be excluded.

## Mitsubishi

- MUT-II and MUT-III are Mitsubishi's tools. No official wire-level specification is public; the MUT-II and MUT-III manuals on manual sites cover operating procedures ([ManualsLib](https://www.manualslib.com/manual/1602765/Mitsubishi-Mut-Ii.html)). A Mitsubishi technical paper says the ECUs are compatible with KWP2000 ([KWP2000 on CAN](https://alflash.com.ua/avtovideo/library_mmc/KWP2000%20on%20CAN16E_17.pdf), listed in search results; not opened). Whether MUT-II uses ISO 9141 framing is unconfirmed: no result tied them together.
- [libmut](https://github.com/harshadura/libmut) is an implementation of MUT-III using an OpenPort OBD-II cable; its README is minimal, so its source is the document. The i-MiEV forum discusses the effort of building an open MUT clone by recording CAN traffic from a real MUT-III ([myimiev](https://myimiev.com/goto/post?id=49328)).
- Standard J1979 data works through an ELM327 on the CAN-era cars; the i-MiEV is an EV and its battery data on the OBD port is not documented in anything I opened.

## Suzuki

- I found nothing Suzuki-specific: no SDL or Suzuki-flavoured K-line documentation, no extended PID list. Cars of that period using pin 7 are likely K-line ([muki01 library](https://awesome.ecosyste.ms/projects/github.com%2Fmuki01%2Fobd2_kline_library)), so standard J1979 over K-line is the expected route and everything else is unconfirmed. [OpenDiag](https://www.tindie.com/products/opendiag/opendiag-open-source-obd2-interface/) is an open interface supporting K-line, CAN and J1850 with ELM327-style AT commands (vendor page, not opened beyond the listing).

## Hyundai, Kia and Genesis

- **Era.** The only source I opened on K-line says KWP2000 on K-line remains the main path for many Hyundai/Kia modules; it is an industrial blog and unconfirmed ([industrialmonitordirect](https://industrialmonitordirect.com/ko/blogs/knowledgebase/siemens-s7-300-to-abs-ecu-kwp2000-k-line-integration-guide)). Nothing I opened documents the GDS or older Hi-Scan protocol framing.
- **EV and hybrid battery data over CAN.** The community reference is [JejuSoul/OBD-PIDs-for-HKMC-EVs](https://github.com/JejuSoul/OBD-PIDs-for-HKMC-EVs): Torque Pro PID files for Kona EV and Niro EV, Ioniq EV, HEV and PHEV, Niro HEV and PHEV, Optima PHEV, Ray EV and Soul EV in three battery sizes. Its README is "ONLY INTENDED FOR SCIENTIFIC USAGE", it does not explain headers, and it says the 64 kWh variants should use the same codes but still need testing.
- **Addresses.** A shared "Kona PIDs" spreadsheet lists request/response pairs: BMS 7E4/7EC with 220101 to 220105, VMCU 7E2/7EA with 2101 and 2102, MCU 7E3/7EB, on-board charger 7E5/7ED, body control 7A0/7A8, cluster 7C6/7CE (odometer 22B002), air conditioning 7B3/7BB, ABS/ESP 7D1/7D9 and the integrated gateway module 770/778 ([Kona PIDs sheet](https://docs.google.com/spreadsheets/d/1-9jZafV9eZeBUnPQo7qQHbX2-_4qZfWfRVpidoF1owA)). Other posts give header 7E4 with mode 220 PID 105 (54 bytes) for Kona SOC and SOH, and mode 220 PID 101 for battery power, with one user reporting wrong values on an Ioniq ([AutoPi community](https://community.autopi.io/t/hyundai-kona-ionic-ev/723/57), [page 6](https://community.autopi.io/t/hyundai-kona-ionic-ev/723?page=6)). Responses to 2101 begin with the ECU ID in the header, so only lines starting 7EC should be parsed, and multi-line responses (battery current is split across two) need reassembly ([Stack Overflow, mirrored](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/57306799/how-to-decode-obd-2-data-from-hyundai-ioniq-ev)).
- **Conditions.** Battery queries are reported to answer only with the car on or charging ([AutoPi community](https://community.autopi.io/t/hyundai-ioniq-battery-level-timing-for-conditioning/59?page=2)). Which variant a given address, PID and formula applies to differs between Ioniq, Kona, Niro and Soul, so treat each as per-model.
- **Apps and services.** [EVNotify](https://github.com/EVNotify/EVNotify) is an open-source Android app (originally for the Ioniq) that reads state of charge over a Bluetooth OBD-II dongle, with its backend at [EVNotifyBackend](https://github.com/EVNotify/EVNotifyBackend); its wiki lists compatible dongles. The ABRP community reports an ELM327 reading only part of the telemetry on an Ioniq 5 ([ABRP featurebase](https://abrp.featurebase.app/p/elm327-obd-connects-but-doesnt-read-all-telemetry-data-ioniq5-2)); the cause is unconfirmed.
- **Car Scanner** lists Toyota and Hyundai connection profiles in its store listing, which is marketing copy rather than documentation ([App Store](https://apps.apple.com/app/id1259933623)). A beginner guide says the correct profile gives access to all modules and the wrong one limits you to the engine ([iamcarhacker](https://iamcarhacker.com/obd2-scanner/tool-guides/how-to-use-car-scanner-elm-obd2-app/)). An uncited blog claims a community PID database; unconfirmed.

## Cross-make resources

- [OBDb](https://github.com/OBDb) is an open community project documenting diagnostic parameters and DTCs, organised as a repository per make and model, with [SAEJ1979](https://github.com/OBDb/SAEJ1979) for the standard PIDs. Its repository listing, read directly, showed Toyota (RAV4 Prime), Honda (Accord) and Kia (Optima) repositories among the entries visible, with none visible for Hyundai, Nissan, Mazda or Subaru, but the page showed only a sample, so coverage beyond those is unconfirmed. A later listing through `gh repo list OBDb` showed repositories for Mazda (3, CX-5, CX-30, CX-50, CX-60, MX-5) and for several Honda and Acura models, which the shipped Mazda and Honda profiles below draw on.
- [opendbc](https://github.com/commaai/opendbc) (MIT) provides DBC files for the broadcast CAN signals of many cars, built for openpilot. It is about passively decoding broadcast frames, not OBD-II request/response; that distinction is my inference from its description, and the make list is on its own `docs/CARS.md`, which I did not open.
- [awesome-canbus](https://github.com/iDoka/awesome-canbus) is a curated index; its OBD-II section lists tools such as [freediag](https://github.com/fenugrec/freediag) (free diagnostic software for OBD-II, relevant to K-line), [ELM327-emulator](https://github.com/Ircama/ELM327-emulator) (useful for testing a tool without a car) and [ecu-simulator](https://github.com/lbenthins/ecu-simulator). It links [awesome-automotive-can-id](https://github.com/iDoka/awesome-automotive-can-id); I did not open that list.
- [python-obd](https://python-obd.readthedocs.io/en/latest/Command%20Tables/) documents mode 01 and related command tables, and is the usual Python reference for ELM327 handling.
- [OVMS](https://docs.openvehicles.com/en/latest/components/vehicle_nissanleaf/docs/index.html) (Open Vehicle Monitoring System) documents EV integrations at the CAN level including the Leaf, with controls (charging, climate, locks) that are out of scope for a read-only tool.
- Torque Pro extended-PID CSV format: make-specific CSV files carry the header, mode and PID, which a Python tool can import as a data source rather than hard-coding values. The format itself was not checked against Torque's documentation here (unconfirmed).

## Per-make summary for implementation

| Make                | Standard J1979 via ELM327 | Enhanced data via ELM327                                                              | Native protocol needing other hardware                    |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Toyota/Lexus        | Yes, K-line or CAN        | CAN hybrids: mode 21/22 with module header, car-specific                              | Techstream-style K-line enhanced data (undocumented here) |
| Honda/Acura         | Yes                       | Engine data in most reports; 29-bit unit addresses (`honda-acura-29bit`, unconfirmed) | HDS-style K-line modules and the gateway                  |
| Nissan/Infiniti     | Yes                       | Leaf via Car-CAN frames and 79B/7BB                                                   | Consult I and II (cable)                                  |
| Mazda               | Yes                       | Mode 22 on 7E0 and other headers (`mazda-skyactiv`, unconfirmed)                      | MS-CAN modules (unconfirmed)                              |
| Subaru              | Yes (mode 01, ECU ID)     | SSM-CAN A8 reads not shown to work on stock ELM327                                    | SSM1 and SSM2 K-line (reflashed or K-line cable)          |
| Mitsubishi          | Yes                       | Not documented in sources opened                                                      | MUT-II, MUT-III (libmut with OpenPort)                    |
| Suzuki              | Yes (expected)            | None found                                                                            | None found                                                |
| Hyundai/Kia/Genesis | Yes                       | EV and hybrid battery: 7E4, 7E2 and others with 21/22                                 | GDS, Hi-Scan (undocumented here)                          |

## Design implications for obd-read

- Probe protocol first, then module-by-module: for each candidate header send a harmless read (mode 09 or a documented DID) and record only modules that answer; do not assume the headers above.
- Keep make-specific tables as data (header, service, identifier, length, scaling, source URL, confidence), importable from Torque CSVs and the sheets above, with a per-entry "verified on" field filled in only from a test on a real car.
- Gate K-line proprietary protocols (SSM, Consult, MUT) behind a separate transport layer and an adapter capability check; do not try them through a stock ELM327.
- Never include write, clear, adaptation, coding, actuator or flash services in any table, and refuse security access.

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- https://aim-sportline.com/download/ecu/stock/honda/Honda_CivicUSA_2006-2011_eng.pdf (http://web.archive.org/web/20250320052132/https://www.aim-sportline.com/download/ecu/stock/honda/Honda_CivicUSA_2006-2011_eng.pdf)
- https://alflash.com.ua/avtovideo/library_mmc/KWP2000%20on%20CAN16E_17.pdf (http://web.archive.org/web/20160929113048/http://alflash.com.ua:80/avtovideo/library_mmc/KWP2000%20on%20CAN16E_17.pdf)
- https://apps.apple.com/app/id1259933623 (http://web.archive.org/web/20230105124224/https://apps.apple.com/app/id1259933623)
- https://blog.obdii365.com/2019/06/25/subaru-freessm-can-work-kkl-vag-com-cables/ (http://web.archive.org/web/20260808105258/https://blog.obdii365.com/2019/06/25/subaru-freessm-can-work-kkl-vag-com-cables/)
- https://forum.arduino.cc/t/nissan-consult-and-arduino/232484 (http://web.archive.org/web/20260315175609/https://forum.arduino.cc/t/nissan-consult-and-arduino/232484)
- https://github.com/Comer352L/FreeSSM (http://web.archive.org/web/20260627031233/https://github.com/Comer352L/FreeSSM)
- https://github.com/EVNotify/EVNotify (http://web.archive.org/web/20260825230443/https://github.com/EVNotify/EVNotify)
- https://github.com/EVNotify/EVNotifyBackend (http://web.archive.org/web/20250612183447/https://github.com/EVNotify/EVNotifyBackend)
- https://github.com/Ircama/ELM327-emulator (http://web.archive.org/web/20260325230813/https://github.com/Ircama/ELM327-emulator)
- https://github.com/OBDb (http://web.archive.org/web/20261030142740/https://github.com/OBDb)
- https://github.com/commaai/opendbc (http://web.archive.org/web/20261020000148/https://github.com/commaai/opendbc)
- https://github.com/fenugrec/freediag (http://web.archive.org/web/20260517000958/https://github.com/fenugrec/freediag)
- https://github.com/harshadura/libmut (http://web.archive.org/web/20230307210817/https://github.com/harshadura/libmut)
- https://github.com/iDoka/awesome-automotive-can-id (http://web.archive.org/web/20260901132908/https://github.com/iDoka/awesome-automotive-can-id)
- https://github.com/iDoka/awesome-canbus (http://web.archive.org/web/20260706021423/https://github.com/iDoka/awesome-canbus)
- https://github.com/lbenthins/ecu-simulator (http://web.archive.org/web/20250630055502/https://github.com/lbenthins/ecu-simulator)
- https://github.com/src0x/LibSSM2 (http://web.archive.org/web/20260527011726/https://github.com/src0x/LibSSM2)
- https://leaf-obd.readthedocs.io/en/latest/pid/index.html (http://web.archive.org/web/20260222183100/https://leaf-obd.readthedocs.io/en/latest/pid/index.html)
- https://leaf-obd.readthedocs.io/en/latest/tutorial/elm327.html (http://web.archive.org/web/20250517203723/https://leaf-obd.readthedocs.io/en/latest/tutorial/elm327.html)
- https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols (http://web.archive.org/web/20251210044504/https://learn.sparkfun.com/tutorials/getting-started-with-obd-ii/obd-ii-protocols)
- https://mynissanleaf.com/viewtopic.php?p=586558 (http://web.archive.org/web/20200924124003/https://mynissanleaf.com/viewtopic.php?p=586558)
- https://obdplanet.com/obd2-protocol (http://web.archive.org/web/20261017220911/https://obdplanet.com/obd2-protocol/)
- https://oguchi-rd.com/Accomplishment/Automobile/07%20Toyota%20Prius/Parameter%20IDs/Toyota%20Gen%202%20Prius%20PIDs.pdf (http://web.archive.org/web/20260518100242/https://www.oguchi-rd.com/Accomplishment/Automobile/07%20Toyota%20Prius/Parameter%20IDs/Toyota%20Gen%202%20Prius%20PIDs.pdf)
- https://python-obd.readthedocs.io/en/latest/Command%20Tables/ (http://web.archive.org/web/20260329183825/https://python-obd.readthedocs.io/en/latest/Command%20Tables/)
- https://racechrono.com/forum/discussion/comment/11271 (http://web.archive.org/web/20250622170335/https://racechrono.com/forum/discussion/comment/11271)
- https://scithings.id.au/OBD_PID.pdf (http://web.archive.org/web/20250313041929/https://scithings.id.au/OBD_PID.pdf)
- https://support.obdlink.com/support/solutions/articles/43000711154 (http://web.archive.org/web/20260722203855/https://support.obdlink.com/support/solutions/articles/43000711154)
- https://www.quantexlab.com/en/develop/elm327.html (http://web.archive.org/web/20260711113833/https://quantexlab.com/en/develop/elm327.html)
- https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf (http://web.archive.org/web/20260816193921/https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf)
- https://www.scribd.com/document/902944802/GitHub-AutotronicCommunity-ArduinoHondaOBD (http://web.archive.org/web/20251102194123/https://www.scribd.com/document/902944802/GitHub-AutotronicCommunity-ArduinoHondaOBD)

No snapshot found:

- https://abrp.featurebase.app/p/elm327-obd-connects-but-doesnt-read-all-telemetry-data-ioniq5-2
- https://awesome.ecosyste.ms/projects/github.com%2Fmuki01%2Fobd2_kline_library
- https://cdn.shopify.com/s/files/1/0085/7699/1298/files/HONDA_V01.20_Diagnostic_Function_List_FULL.pdf
- https://community.autopi.io/t/hyundai-ioniq-battery-level-timing-for-conditioning/59?page=2
- https://community.autopi.io/t/hyundai-kona-ionic-ev/723/57
- https://community.autopi.io/t/hyundai-kona-ionic-ev/723?page=6
- https://docs.google.com/spreadsheets/d/1-9jZafV9eZeBUnPQo7qQHbX2-_4qZfWfRVpidoF1owA
- https://docs.openvehicles.com/en/latest/components/vehicle_nissanleaf/docs/index.html
- https://forum.ih8mud.com/threads/custom-pid-for-1kd-ftv-injector-feedback-car-scanner-torque.1384815/
- https://gist.github.com/agronick/4d01cfe7f94dd41eeeb46f5e5dd204b8
- https://github.com/JejuSoul/OBD-PIDs-for-HKMC-EVs
- https://github.com/NJbubo/leaf_can_bus_messages
- https://github.com/OBDb/SAEJ1979
- https://github.com/eatinginternet/SubaruDefs
- https://github.com/jonsim/openconsult
- https://honda-tech.com/forums/sitemap/t-3366115.html
- https://iamcarhacker.com/obd2-scanner/tool-guides/how-to-use-car-scanner-elm-obd2-app/
- https://industrialmonitordirect.com/blogs/knowledgebase/diagnosing-nissan-leaf-4th-capacity-bar-drop-soh-and-soc-analysis
- https://industrialmonitordirect.com/ko/blogs/knowledgebase/siemens-s7-300-to-abs-ecu-kwp2000-k-line-integration-guide
- https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/57306799/how-to-decode-obd-2-data-from-hyundai-ioniq-ev
- https://leaf-obd.readthedocs.io/en/latest/pid/5b3.html
- https://www.evoscan.com/technical-vehicle-manuals/107
- https://www.romraider.com/
- https://www.romraider.com/forum/viewtopic.php?p=147609
- https://www.romraider.com/forum/viewtopic.php?p=147617
- https://www.romraider.com/forum/viewtopic.php?p=151518
- https://www.romraider.com/forum/viewtopic.php?p=161735
- https://www.romraider.com/forum/viewtopic.php?p=165956
- https://www.romraider.com/index.php/RomRaider/SsmProtocol
- https://mx5-nd-forum.de/forum/thread/7187-tpms-data-through-obd-ecu
- https://myimiev.com/goto/post?id=49328
- https://nissanecu.miraheze.org
- https://nisscan.com/phpBB3/viewtopic.php?p=981
- https://nisscan.com/product/nds-iii-android-app/
- https://nisscan.com/which-nds-software/
- https://pinouts.ru/CarElectronics/Toyota_lexus_obd2_diagnostic.shtml
- https://priuschat.com/posts/3582276
- https://racechrono.com/forum/discussion/comment/10804/
- https://reddit.ny4.dev/r/carhacking
- https://relatedrepos.com/gh/fridlington/K11Consult
- https://www.hackster.io/jvarner4/obd-ii-information-logger-and-diagnostics-reader-952dd9
- https://www.hpacademy.com/es/foro/ajuste-de-inyeccion-electronica-de-combustible/show/setting-up-rom-raider/
- https://github.com/OBDb/Honda-Civic/blob/main/signalsets/v3/default.json (https://web.archive.org/web/20261115134434/https://github.com/OBDb/Honda-Civic/blob/main/signalsets/v3/default.json)
- https://github.com/OBDb/Honda-CR-V/blob/main/signalsets/v3/default.json (https://web.archive.org/web/20261115134522/https://github.com/OBDb/Honda-CR-V/blob/main/signalsets/v3/default.json)
- https://github.com/OBDb/Mazda-3/blob/main/signalsets/v3/default.json (https://web.archive.org/web/20261115134154/https://github.com/OBDb/Mazda-3/blob/main/signalsets/v3/default.json)
- https://github.com/OBDb/Mazda-CX-5/blob/main/signalsets/v3/default.json (https://web.archive.org/web/20261115134243/https://github.com/OBDb/Mazda-CX-5/blob/main/signalsets/v3/default.json)
- https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/fingerprints.py (https://web.archive.org/web/20261115134702/https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/fingerprints.py)
- https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/values.py (https://web.archive.org/web/20261115135151/https://github.com/commaai/opendbc/blob/master/opendbc/car/honda/values.py)
- https://github.com/commaai/opendbc/blob/master/opendbc/car/mazda/fingerprints.py (https://web.archive.org/web/20261115135011/https://github.com/commaai/opendbc/blob/master/opendbc/car/mazda/fingerprints.py)
- https://www.manualslib.com/manual/1602765/Mitsubishi-Mut-Ii.html
- https://www.priuschat.com/goto/post?id=1754304
- https://www.priuschat.com/goto/post?id=2241649
- https://www.priuschat.com/goto/post?id=2489140
- https://www.tindie.com/products/opendiag/opendiag-open-source-obd2-interface/

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://aim-sportline.com/download/ecu/stock/honda/Honda_CivicUSA_2006-2011_eng.pdf
- https://blog.obdii365.com/2019/06/25/subaru-freessm-can-work-kkl-vag-com-cables/
- https://iamcarhacker.com/obd2-scanner/tool-guides/how-to-use-car-scanner-elm-obd2-app/
- https://pinouts.ru/CarElectronics/Toyota_lexus_obd2_diagnostic.shtml
- https://racechrono.com/forum/discussion/comment/10804/
- https://racechrono.com/forum/discussion/comment/11271
- https://reddit.ny4.dev/r/carhacking
