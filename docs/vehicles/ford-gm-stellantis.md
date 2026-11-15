# American-market vehicles through the OBD-II port: Ford, Lincoln, GM, Stellantis and Tesla

Summary: American-origin vehicles are reachable by a read-only tool in two tiers. The legislated tier (SAE J1979 modes 01 to 0A over J1850 PWM for Ford, J1850 VPW for GM and Chrysler, ISO 9141-2 or KWP2000 for some Chrysler, and ISO 15765-4 CAN on pins 6 and 14 from the 2008 model year) works with any ELM327-compatible adapter. The manufacturer tier (enhanced PIDs, per-module DTCs, body and chassis modules) sits partly on the same CAN pins (Ford PCM at 0x7E0, ABS at 0x760, GM GMLAN modules) and partly on buses the standard OBD-II pins do not carry: Ford MS-CAN on pins 3 and 11, GM single-wire CAN on pin 1, and Chrysler CCD. A stock ELM327 reaches none of those extra buses; an STN-based adapter (OBDLink MX+, and the EX for MS-CAN only) or a switch-equipped Ford adapter driven by FORScan does. The enhanced services are proprietary, so a read-only open tool depends on community PID lists and on each vehicle being checked, never on a universal table. Coding, flashing and module programming are out of scope here. Where this document could not confirm a statement it says "unconfirmed" and gives the reason.

## Scope and conventions

- Read-only: standard J1979 requests, plus manufacturer read services (UDS ReadDataByIdentifier 0x22, GMLAN 0x1A and 0xAA, DTC reads). Anything that writes, actuates, clears, programs or unlocks security access is out of scope.
- Source quality: the vendor datasheets and manuals cited are primary for the hardware. Module addresses and PID lists come from community forums and are tagged as such.
- Ford and Lincoln share architecture, as do GM, Chevrolet, Cadillac, Buick, GMC, Opel and Vauxhall for the GMLAN era. Stellantis covers the former Chrysler, Dodge, Jeep, Ram and FCA brands.

## US OBD-II mandates by year

- OBD-II is required on US passenger cars and light petrol trucks from the 1996 model year; diesel and heavier classes were phased in later (California diesels to 14,000 lb in 1997, petrol vehicles to 14,000 lb by 2004, all vehicles at or under 14,000 lb GVWR by 2006) according to [Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics). The phasing for heavier vehicles continues to the 2013 model year on the same page.
- From the 2008 model year every car sold in the US must use ISO 15765-4 CAN for the diagnostic link ([Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics)). The primary text is 40 CFR 86.1806, which I could not open (see the end of this document); treat the year as secondary-sourced.
- The five legislated signalling protocols and their pins (J1850 PWM on pins 2 and 10, J1850 VPW on pin 2, ISO 9141-2 and ISO 14230 on pin 7 with optional pin 15, CAN on pins 6 and 14) are listed in the same Wikipedia article. Pins 1, 3, 8, 9, 11, 12 and 13 are left to the manufacturer, which is where MS-CAN, SW-CAN, CCD and similar buses live.
- Practical consequence: a US car built before 2008 can be on any of the five protocols, so auto-detection (ATSP0) is the right default, and a pre-1996 car has no J1979 interface at all.

## What an ELM327 can and cannot do

- The ELM327 datasheet lists protocols 1 to 9 (J1850 PWM, J1850 VPW, ISO 9141-2, ISO 14230-4 slow and fast, and ISO 15765-4 CAN at 11 or 29 bit and 500 or 250 kbaud), A (SAE J1939) and two user-defined CAN protocols, B (11-bit, 125 kbaud default, adjustable) and C (11-bit, 50 kbaud default, adjustable) ([ELM327 datasheet](https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)).
- The user-defined CAN protocols change the bit rate and ID format only. The ELM327 CAN pins in the datasheet drive the differential transceiver on OBD pins 6 and 14. Reaching pins 3 and 11 (MS-CAN) or pin 1 (SW-CAN) needs a different transceiver and wiring, not a different AT setting. This is an inference from the datasheet's single CAN interface, unconfirmed against a schematic of a specific clone.
- FORScan's own forum states that a stock ELM327 handles Ford HS-CAN (pins 6 and 14) but MS-CAN is on non-OBD2 pins, and that modified ELM327 units with an HS/MS switch are used for it ([FORScan forum, MS CAN with modified ELM327](https://forum.forscan.org/viewtopic.php?p=4)).
- Clone chips are a reliability risk in their own right. FORScan keeps a thread on [known problems with Chinese ELM327 clones](https://forum.forscan.org/viewtopic.php?p=33140), and its home page recommends OBDLink and vLinker adapters (as quoted in a search summary; the home page itself was not opened).
- A read-only tool should detect the adapter family (`ATI`, `AT@1`, `STI`) before offering any non-OBD pin bus, and refuse MS-CAN or SW-CAN selections on a plain ELM327.

## STN-based adapters (OBDLink, vLinker) and the extra buses

- STN chips are ELM327-compatible and add an `ST` command set. The STN1170 and STN2120 datasheets list SAE J1850 VPW and PWM, GM single-wire CAN (GMW3089) and Ford MS-CAN as supported, plus J1939 ([STN1170 datasheet](https://www.scantool.net/downloads/132/stn1170-ds.pdf), [STN2120 datasheet](https://www.scantool.net/scantool/downloads/206/stn2120-ds.pdf)).
- The vendor page for the STN2120 says the ST commands can access, monitor and issue commands on SW-CAN and MS-CAN, but that the GM and Ford proprietary message definitions must be obtained independently (for example through the Equipment and Tool Institute) or reverse engineered ([OBD Solutions, STN2120](https://obdsol.com/solutions/chips/stn2120)). The same page lists the chip as discontinued, so its datasheets describe the family rather than a part to design in.
- Which retail adapter has which bus, from OBDLink's support table: MX+ has J1850 PWM, J1850 VPW, MS-CAN and SW-CAN; EX has PWM, VPW and MS-CAN; LX has PWM and VPW; CX has none of the four. OBDLink adds that the CX will not work on GM, Ford and certain FCA vehicles built before the 2008 model year ([OBDLink support, protocol table](https://support.obdlink.com/support/solutions/articles/43000713351)).
- The FORScan forum reports that an OBDLink MX with its MS-CAN protocol preset reached a 2015 Ford Fusion Hybrid's HS2-CAN, and that FORScan added HS2 and HS3 support for adapters with MS-CAN support, working only through the Ford DLC in normal mode ([FORScan forum, HS2-CAN on the DLC](https://forum.forscan.org/viewtopic.php?p=15634)).
- The exact `ATSP`/`STP` numbers for MS-CAN and SW-CAN: unconfirmed. The datasheets I opened list the capability but I did not extract protocol numbers from the STN family reference manual, and a vLinker forum thread suggesting `AT SP 8` for SW-CAN is a single user suggestion ([vLinker forum](https://forum.vgatemall.com/showthread.php?pid=8804)). Read the [STN11xx and STN21xx family reference manual](https://obdsol.com/solutions/chips/stn2120) for the numbers before coding them.
- OBDLink's guidance is that compatibility follows where the vehicle was originally sold, not where it was built (OBDLink troubleshooting guide, per a search summary; page itself not opened). That matters for a UK-registered US import.

## Ford and Lincoln

### Buses by era

- Pre-2008: J1850 PWM (41.6 kbit/s, pins 2 and 10) on Ford passenger cars and light trucks, with CAN arriving on some models before the mandate. Protocol 1 in the ELM327 list. Protocol detail from [Wikipedia, On-board diagnostics](https://en.wikipedia.org/wiki/On-board_diagnostics).
- HS-CAN on pins 6 and 14 at 500 kbit/s is the OBD-II CAN. The FORScan forum confirms Ford HS-CAN on pins 6 and 14 and MS-CAN on pins 3 and 11 ([FORScan forum](https://forum.forscan.org/viewtopic.php?p=4)). Many Ford and Mazda models from about 2003 to 2004 have MS-CAN, per the same thread.
- MS-CAN bit rate: a hobbyist report mentions 125 kbit/s on pins 3 and 11 ([Arduino forum](https://forum.arduino.cc/t/arduino-uno-canbus-shield-ms-can-hs-can/62618)), and the ELM327's User1 CAN default of 125 kbaud matches it, but the same forum also lists 250 kbit/s as a question mark. Treat 125 kbit/s as likely and unconfirmed against a Ford service document.
- Newer Ford hybrids and plug-in hybrids: the FORScan thread above reports HS2-CAN replacing MS-CAN on the DLC, with conflicting posts about whether it sits on pins 3 and 11 or 8 and 12, and no settled answer on which models. Detect, do not assume.

### Module addressing and services

- PCM on 0x7E0 is reported by Ford owners' forums ([Mustang Source](https://themustangsource.com/forums/f726/can-bus-how-our-cars-modules-communicate-529879)), and a 2023 F-150 service bulletin lists PCM 7E0, BECM 7E4, SOBDMC 7E6 and ABS 760 ([NHTSA TSB](https://static.nhtsa.gov/odi/tsbs/2024/MC-10251477-0001.pdf)). Response IDs follow the ISO 15765-4 rule of request plus 8 (so PCM 0x7E8, ABS 0x768 per a RaceChrono forum user, [RaceChrono](https://racechrono.com/forum/discussion/comment/12814)); the TCM on 0x7E1 is unconfirmed, as no Ford source I opened states it.
- Ford enhanced data is a manufacturer extension of OBD service 0x22 (read by identifier) with two-byte PIDs, described by community sources as proprietary ([Ford-Trucks forum](https://www.ford-trucks.com/forums/1579756-extended-can-pid-codes-mode-22-obd2.html)). Whether a given module uses UDS-conformant framing or an older Ford set varies by era: unconfirmed for any specific year.
- FORScan is the community reference for Ford and Mazda module lists and works through ELM327, OBDLink and vLinker adapters ([FORScan forum, compatibility table](https://forum.forscan.org/viewtopic.php?p=95958); [community adapter summary](https://community.cyanlabs.net/t/forscan-supported-adapters-protocols-and-platforms/5487)). FORScan is closed software; an open tool should read its published module and PID knowledge only where licensing allows, and never copy its tables wholesale.
- Torque Pro extended PID csv files for Ford are community-maintained and inconsistent. Examples: a spreadsheet of F-150 Lightning PIDs reformatted for Torque ([F150 Lightning forum](https://www.f150lightningforum.com/forum/threads/f150-lightning-torque-app-and-pid-list.28216/post-643955)) and a 6.7 litre diesel list ([Ford-Trucks](https://www.ford-trucks.com/forums/1322804-torque-pro-ford-6-7l-extended-pids.html?nojs=1)). Their authors warn some PIDs may be inaccurate, so each needs checking against live data.

## GM, Chevrolet, Cadillac, Buick, GMC, Opel and Vauxhall

### Buses by era

- Pre-2008: J1850 VPW (10.4 kbit/s, pin 2) on GM, protocol 2 in the ELM327 list ([Wikipedia](https://en.wikipedia.org/wiki/On-board_diagnostics)). GM's enhanced diagnostic language on VPW is "Class 2"; the term appears in a GM service document on Corvette serial data ([Corvette Forum attachment](https://www.corvetteforum.com/forums/attachments/c6-corvette-zr1-and-z06/48068162d1488321898-scm-seat-class-2-serial-data-aab-data-link.description-2008..pdf)), which I did not read in full, so the Class 2 service set is not summarised here.
- GMLAN is GM's application and diagnostic layer on CAN: standardised as SAE J2411 for single-wire use, with ISO 15765-2 transport ([Wikipedia, GMLAN](https://en.wikipedia.org/wiki/General_Motors_Local_Area_Network)). The Wikipedia page flags itself as needing citations.
- Pin 1 carries GM's single-wire CAN (SAE J2411, GMW3089) at 33.3 kbit/s in normal operation, per a pinout quoted in a search summary ([CarModder](https://www.carmodder.com/viewtopic.php?p=18424)), and the same forum says pin 1 can also carry other buses depending on model year, so detect, do not assume. The higher-rate programming mode of SW-CAN is a flashing matter and out of scope.
- Dual-wire CAN: GM standard GMW3122 defines the physical layer for dual-wire CAN, with GMW3110 for enhanced diagnostics and GMW3104 for communication strategy, per a search summary of GM documents. Open copies of GM engineering documents are hosted on a rusEFI mirror ([GMW8772 example](https://gitea.interbiznw.com/rusefi/rusefi_documentation/raw/commit/644a7ef21a5a7542cf8f9496ed00bf96aa0219c5/OEM-Docs/GM/GMW8772-2010.pdf)); check licensing before reuse.
- The Saab and Vauxhall/Opel Astra J workshop pages describe GMLAN buses and gateway layout for those platforms ([Saab 9-4X data link](https://saabwisonline.com/9-4x/2011/3-electrical-system/bus-and-diagnostics-communication/technical-description/data-link-communications-description-and-operation), [Vauxhall Astra J](https://workshop-manuals.com/vauxhall/astra-j/power_and_signal_distribution/data_communications/description_and_operation/data_link_communications_description_and_operation/)); I did not extract bus speeds from them.

### Addressing and services

- GMLAN diagnostic services are not UDS. The open `gocan` library's GMLAN package lists them: 0x10 InitiateDiagnosticOperation, 0x1A ReadDataByIdentifier, 0x20 ReturnToNormalMode, 0x23 ReadMemoryByAddress, 0x27 SecurityAccess, 0x28 DisableNormalCommunication, 0x2C DynamicallyDefineMessage, 0x3B WriteDataByIdentifier, 0x3E TesterPresent, 0xA9 ReadDiagnosticInformation, 0xAA ReadDataByPacketIdentifier and 0xAE DeviceControl ([gocan GMLAN package](https://pkg.go.dev/github.com/roffe/gocan/pkg/gmlan)). For read-only work the relevant ones are 0x1A, 0xA9 and 0xAA; everything else writes, programs, actuates or unlocks, and is out of scope.
- The same package names the all-nodes functional request ID 0x101 with extended address 0xFE. It gives no per-module request and response IDs. The common ECM and TCM IDs (for example 0x7E0 and 0x7E2) are unconfirmed: no source I opened lists them for GM.
- Later GM platforms moved diagnostics towards UDS; a trade article titled "The Changing Face of CAN Bus Diagnostics on General Motors Vehicles" exists ([diag.net discussion](https://diag.net/discussion/sl7lwcabhw9vycqlxwjvedpekd)) but I only saw its title, so the transition years are unconfirmed.
- GM's own published OBD documents (mode 6 and diagnostic specifications for recent model years) are hosted on the GM service information site, for example [23OBDG04A](https://gsi.ext.gm.com/gmspo/mode6/pdf/2023/23OBDG04A.pdf); these are public references for legislated data and the closest GM primary source I found.
- Open tooling: OBDLink MX is named among tools that work with GMLAN on the Wikipedia page above. OBD Fusion advertises built-in GM enhanced PIDs ([app listing](https://apps.apple.com/jo/app/id650684932)); it is closed and not a data source for an open tool.

## Chrysler, Dodge, Jeep, Ram and Stellantis

- Chrysler's pre-CAN architecture uses the CCD bus (a differential twisted pair at 7812.5 bit/s, per a Mopar forum article, [mopar1973man](https://mopar1973man.com/cummins/articles.html/24-valve-2nd-generation/engine/electrical/ccd-chrysler-collision-detection-data-bus-r329/)) or the PCI bus (J1850 VPW at 10.4 kbit/s, per a LinkECU forum thread, [LinkECU](https://forums.linkecu.com/topic/13253-dodge-bus-pci-incorporation)). A vehicle has one or the other.
- OBD-II pin use for CCD is inconsistent across sources: pins 3 and 11 are named in one set ([Flexihub pinout](https://www.flexihub.com/oobd2-pinout/)), while a Tindie CCD/PCI board table for 1983 to 2003 vehicles maps CCD to pins 11 and 12 and PCI to pin 2 ([Tindie](https://tindie.com/products/boundarycondition/ccdpci-bus-transceiver-development-board)). I could not settle the pin assignment, so it is unconfirmed; consult the vehicle's wiring diagram. An ELM327 does not speak CCD (the datasheet's protocol list has no CCD entry), so CCD vehicles are reachable only through their legislated OBD protocol, typically ISO 9141-2 or J1850 VPW, per the Wikipedia article's note that ISO 9141-2 is used mainly by Chrysler, European and Asian vehicles.
- SCI (the serial link to the engine and transmission controllers used by Chrysler's factory tools): I found no usable source, so it is unconfirmed here.
- From the 2008 model year, Chrysler products use ISO 15765-4 CAN on pins 6 and 14 like everything else sold in the US.
- Secure Gateway: Stellantis fits a gateway module to most 2018 and later vehicles that blocks clearing codes and bidirectional functions for non-authenticated tools, leaving read of fault codes, VIN and data streams, with AutoAuth the usual route to full access ([Hunter handout](https://globalassets.hunter.com/download/assets/AH08640-00_SecureGateway-Handout_%28RevA_07-26%29.pdf/cfce70107aeb11f1b2450a4934c9f094) and [Repairer Driven News](https://www.repairerdrivennews.com/2023/10/09/fca-gateway-unlock-now-available-on-7111-tablet/), both via a search summary and both from tool-vendor sources with a commercial interest). A read-only tool is, by design, inside what the gateway allows; the exact allowed set per model is unconfirmed.
- No Torque or FORScan equivalent with broad public coverage was found for Stellantis, and the Torque search surfaced no Chrysler or GM CSV at all. Unconfirmed that none exists.

## Tesla

- Tesla service documentation says the Model 3 has a J1962 OBD-II port that does not support DoIP, plus a separate diagnostic port in the left footwell, and that third parties need accreditation for security-related routines ([Tesla Model 3 service manual](https://service.tesla.com/docs/Model3/ServiceManual/en-us/GUID-1255FAF4-AB26-4104-91E0-132F0AAFF872.html)). The Model S page describes a diagnostic port under the touchscreen for earlier builds ([Tesla Model S service manual](https://service.tesla.com/docs/ModelS/ServiceManual/Palladium/en-us/GUID-334598EE-397C-4BEF-B952-F331F87C3551.html), via a search summary).
- Tesla publishes a bulletin on a third-party CAN bus interface for Model 3 and Y ([Tesla CD-20-17-001](https://service.tesla.com/docs/ServiceBulletins/External/CD/CD-20-17-001_Model_3Y_Third-Party_CAN_Bus_Interface_R4.pdf), not opened). Community write-ups say Model 3 and Y CAN is reached from a connector in the centre pedestal, not the OBD port ([Teslatap](https://teslatap.com/modifications/extracting-internal-vehicle-data/), via search summary), and older sources say the OBD connector carries only a minor CAN bus, which may predate later changes.
- Conclusion for a read-only J1979 tool: do not expect standard PIDs from a Tesla. Unconfirmed per model year, because the sources conflict and I did not read the Tesla bulletin.

## J2534, FORScan and the PID ecosystem

- SAE J2534 is a pass-thru API that lets one application drive adapters from different vendors, written originally for Windows, with J2534-5 covering other operating systems ([AutoPi, J2534 explained](https://www.autopi.io/blog/j2534-explained/); [SAE J2534-5](https://saemobilus.sae.org/standards/j2534-5_4_00-pass-thru-interface-alternate-platforms-api-version-0404)). It is mainly for reprogramming, which is out of scope, but J2534 devices can also read diagnostics. An ELM327 is not a J2534 device.
- Open J2534 resources are collected in [OpenJ2534](https://GitHub.com/jakka351/OpenJ2534), including Python projects (unverified for platform support or upkeep). The Rust [j2534](https://docs.rs/j2534) crate loads Windows DLLs.
- opendbc (MIT licence) is comma.ai's collection of DBC files and a Python API; the brands and files in its tree include Ford (`ford_lincoln_base_pt.dbc`, `ford_fusion_2018_pt.dbc`, `ford_cgea1_2_ptcan_2011.dbc`), GM (`gm_global_a_*` including `gm_global_a_lowspeed.dbc`), Chrysler (`chrysler_pacifica_2017_hybrid_private_fusion.dbc`), FCA (`fca_giorgio.dbc`) and Tesla (`tesla_can.dbc`, `tesla_model3_vehicle.dbc`, `tesla_powertrain.dbc`) ([opendbc](https://github.com/commaai/opendbc), [dbc folder](https://github.com/commaai/opendbc/tree/master/opendbc/dbc)). These describe broadcast frames on internal buses, not diagnostic requests, and need a panda-class device or raw CAN access, not an OBD-II adapter's request-response mode.
- python-OBD (GPL-2.0) is a Python library for ELM327 adapters reading standard commands; its README does not mention manufacturer PIDs ([python-OBD](https://github.com/brendan-w/python-OBD)). PyOBD (GPL-2.0) is a GUI built on it, and states it does not read airbag, ABS or body systems ([barracuda-fsh/pyobd](https://github.com/barracuda-fsh/pyobd)). Note the GPL licences before reusing code in a differently licensed tool.
- OBDLink publishes the STN family manuals and datasheets (links above) and an enhanced diagnostics support article that says manufacturer-specific DTCs and PIDs need enhanced diagnostics, with a per-vehicle availability check ([OBDLink support](https://support.obdlink.com/support/solutions/articles/43000713351)).
- GMLAN documentation: Wikipedia's [GMLAN article](https://en.wikipedia.org/wiki/General_Motors_Local_Area_Network), the [gocan GMLAN package](https://pkg.go.dev/github.com/roffe/gocan/pkg/gmlan) and GM's public OBD documents above. FORScan's documentation lives mostly in its forum ([forum.forscan.org](https://forum.forscan.org/)); I did not find a wiki.

## Recommended design points for a read-only `obd-read`

- Detect first: adapter identity (ELM327 or STN, and which STN bus options), then the vehicle protocol with `ATSP0`/`ATDP`, then module presence by probing request IDs, rather than selecting by make.
- Gate non-OBD buses (MS-CAN, SW-CAN, HS2-CAN) on STN identity, and say plainly when an ELM327 cannot reach them.
- Treat Ford 0x7E0 and 0x760, and any GM or Stellantis IDs, as defaults to probe, never as facts, and keep a per-vehicle record of what answered.
- Limit manufacturer reads to a small, allow-listed set of read services (UDS 0x22 and DTC read, GMLAN 0x1A, 0xA9, 0xAA); block anything that writes, clears, programs, actuates or requests security access.
- Keep enhanced PID definitions as data files with a source and a "verified on vehicle" field, since all public lists are community-made and flagged as possibly inaccurate.

## Sources I could not open

- 40 CFR 86.1806 on eCFR (redirected to an unblock page): the 2008 CAN mandate rests on Wikipedia.
- The current STN family reference manual: the scantool.net download URL I tried served an HTML page rather than a PDF, and a [manualsdir copy of the older STN1100 manual](https://www.manualsdir.com/manuals/710473/scantool-stn1100-frpm.html?page=15) only covers CAN protocols 6 to 9 with no SW-CAN or MS-CAN, so STN protocol numbers for those buses remain missing.
- The Tesla CD-20-17-001 bulletin, the Tesla Model S service page, Teslatap and the FORScan home page (seen only in search summaries).
- SAE J2411, GMW3089, GMW3110, GMW3122 and J2534 (paywalled or not fetched).
- Wikipedia's Chrysler Collision Detection page (404).
- The diag.net GM CAN diagnostics article, the Corvette Forum Class 2 PDF, the Saab and Astra workshop pages (titles or summaries only).
- Hunter and Repairer Driven News Secure Gateway pages (search summaries only).

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- https://GitHub.com/jakka351/OpenJ2534 (http://web.archive.org/web/20251104135532/https://github.com/jakka351/OpenJ2534)
- https://community.cyanlabs.net/t/forscan-supported-adapters-protocols-and-platforms/5487 (http://web.archive.org/web/20230309080234/https://community.cyanlabs.net/t/forscan-supported-adapters-protocols-and-platforms/5487)
- https://en.wikipedia.org/wiki/On-board_diagnostics (http://web.archive.org/web/20261106030732/https://en.wikipedia.org/wiki/On-board_diagnostics)
- https://forum.arduino.cc/t/arduino-uno-canbus-shield-ms-can-hs-can/62618 (http://web.archive.org/web/20260208054439/https://forum.arduino.cc/t/arduino-uno-canbus-shield-ms-can-hs-can/62618)
- https://forum.forscan.org/ (http://web.archive.org/web/20261102165135/https://forum.forscan.org/)
- https://github.com/barracuda-fsh/pyobd (http://web.archive.org/web/20261015013535/https://github.com/barracuda-fsh/pyobd)
- https://github.com/brendan-w/python-OBD (http://web.archive.org/web/20260704175432/https://github.com/brendan-w/python-OBD)
- https://github.com/commaai/opendbc (http://web.archive.org/web/20261020000148/https://github.com/commaai/opendbc)
- https://github.com/commaai/opendbc/tree/master/opendbc/dbc (http://web.archive.org/web/20260412035900/https://github.com/commaai/opendbc/tree/master/opendbc/dbc)
- https://mopar1973man.com/cummins/articles.html/24-valve-2nd-generation/engine/electrical/ccd-chrysler-collision-detection-data-bus-r329/ (http://web.archive.org/web/20260114200748/https://mopar1973man.com/cummins/articles.html/24-valve-2nd-generation/engine/electrical/ccd-chrysler-collision-detection-data-bus-r329/)
- https://racechrono.com/forum/discussion/comment/12814 (http://web.archive.org/web/20251214100840/https://racechrono.com/forum/discussion/comment/12814)
- https://saemobilus.sae.org/standards/j2534-5_4_00-pass-thru-interface-alternate-platforms-api-version-0404 (http://web.archive.org/web/20250507052855/https://saemobilus.sae.org/standards/j2534-5_4_00-pass-thru-interface-alternate-platforms-api-version-0404)
- https://service.tesla.com/docs/Model3/ServiceManual/en-us/GUID-1255FAF4-AB26-4104-91E0-132F0AAFF872.html (http://web.archive.org/web/20260715192252/https://service.tesla.com/docs/Model3/ServiceManual/en-us/GUID-1255FAF4-AB26-4104-91E0-132F0AAFF872.html)
- https://service.tesla.com/docs/ModelS/ServiceManual/Palladium/en-us/GUID-334598EE-397C-4BEF-B952-F331F87C3551.html (http://web.archive.org/web/20260512092404/https://service.tesla.com/docs/ModelS/ServiceManual/Palladium/en-us/GUID-334598EE-397C-4BEF-B952-F331F87C3551.html)
- https://support.obdlink.com/support/solutions/articles/43000713351 (http://web.archive.org/web/20260722203855/https://support.obdlink.com/support/solutions/articles/43000713351)
- https://teslatap.com/modifications/extracting-internal-vehicle-data/ (http://web.archive.org/web/20260713000950/https://teslatap.com/modifications/extracting-internal-vehicle-data/)
- https://themustangsource.com/forums/f726/can-bus-how-our-cars-modules-communicate-529879 (http://web.archive.org/web/20160715214829/http://themustangsource.com:80/forums/f726/can-bus-how-our-cars-modules-communicate-529879/)
- https://tindie.com/products/boundarycondition/ccdpci-bus-transceiver-development-board (http://web.archive.org/web/20260503105402/https://www.tindie.com/products/boundarycondition/ccdpci-bus-transceiver-development-board/)
- https://www.autopi.io/blog/j2534-explained/ (http://web.archive.org/web/20261018014511/https://www.autopi.io/blog/j2534-explained/)
- https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf (http://web.archive.org/web/20261108174631/https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf)
- https://www.flexihub.com/oobd2-pinout/ (http://web.archive.org/web/20260515013925/https://www.flexihub.com/oobd2-pinout/)
- https://www.repairerdrivennews.com/2023/10/09/fca-gateway-unlock-now-available-on-7111-tablet/ (http://web.archive.org/web/20250119172034/https://www.repairerdrivennews.com/2023/10/09/fca-gateway-unlock-now-available-on-7111-tablet/)
- https://www.scantool.net/downloads/132/stn1170-ds.pdf (http://web.archive.org/web/20240816020108/https://www.scantool.net/downloads/132/stn1170-ds.pdf)

No snapshot found:

- https://apps.apple.com/jo/app/id650684932
- https://diag.net/discussion/sl7lwcabhw9vycqlxwjvedpekd
- https://docs.rs/j2534
- https://en.wikipedia.org/wiki/General_Motors_Local_Area_Network
- https://forum.forscan.org/viewtopic.php?p=15634
- https://forum.forscan.org/viewtopic.php?p=33140
- https://forum.forscan.org/viewtopic.php?p=4
- https://forum.forscan.org/viewtopic.php?p=95958
- https://forum.vgatemall.com/showthread.php?pid=8804
- https://forums.linkecu.com/topic/13253-dodge-bus-pci-incorporation
- https://gitea.interbiznw.com/rusefi/rusefi_documentation/raw/commit/644a7ef21a5a7542cf8f9496ed00bf96aa0219c5/OEM-Docs/GM/GMW8772-2010.pdf
- https://globalassets.hunter.com/download/assets/AH08640-00_SecureGateway-Handout_%28RevA_07-26%29.pdf/cfce70107aeb11f1b2450a4934c9f094
- https://gsi.ext.gm.com/gmspo/mode6/pdf/2023/23OBDG04A.pdf
- https://obdsol.com/solutions/chips/stn2120
- https://pkg.go.dev/github.com/roffe/gocan/pkg/gmlan
- https://saabwisonline.com/9-4x/2011/3-electrical-system/bus-and-diagnostics-communication/technical-description/data-link-communications-description-and-operation
- https://service.tesla.com/docs/ServiceBulletins/External/CD/CD-20-17-001_Model_3Y_Third-Party_CAN_Bus_Interface_R4.pdf
- https://static.nhtsa.gov/odi/tsbs/2024/MC-10251477-0001.pdf
- https://workshop-manuals.com/vauxhall/astra-j/power_and_signal_distribution/data_communications/description_and_operation/data_link_communications_description_and_operation/
- https://www.carmodder.com/viewtopic.php?p=18424
- https://www.corvetteforum.com/forums/attachments/c6-corvette-zr1-and-z06/48068162d1488321898-scm-seat-class-2-serial-data-aab-data-link.description-2008..pdf
- https://www.f150lightningforum.com/forum/threads/f150-lightning-torque-app-and-pid-list.28216/post-643955
- https://www.ford-trucks.com/forums/1322804-torque-pro-ford-6-7l-extended-pids.html?nojs=1
- https://www.ford-trucks.com/forums/1579756-extended-can-pid-codes-mode-22-obd2.html
- https://www.manualsdir.com/manuals/710473/scantool-stn1100-frpm.html?page=15
- https://www.scantool.net/scantool/downloads/206/stn2120-ds.pdf

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://racechrono.com/forum/discussion/comment/12814
- https://service.tesla.com/docs/ServiceBulletins/External/CD/CD-20-17-001_Model_3Y_Third-Party_CAN_Bus_Interface_R4.pdf
- https://www.carmodder.com/viewtopic.php?p=18424
