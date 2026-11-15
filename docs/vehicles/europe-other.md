# Talking to French, Italian, British and Swedish vehicles through the OBD-II port

This is a reference for a read-only Python tool (`obd-read`) that speaks to Renault/Dacia, Peugeot/Citroen/DS (PSA), Fiat/Alfa Romeo/Lancia, Volvo, Jaguar/Land Rover and Saab vehicles through an ELM327 or STN-style adapter. The short version: the legislated OBD-II layer (J1962 pins 6 and 14 for CAN, pin 7 for K-line) works through any adapter, but most of what is interesting on these makes (ABS, airbag, body, gearbox, instrument cluster) sits either on K-lines at non-standard pins, on a second CAN bus on non-standard pins (PSA pins 3 and 8, Fiat pins 1 and 9, Volvo and Saab pins 3 and 11, JLR pins 3 and 11), or behind a gateway module that filters diagnostic traffic. A stock ELM327 has one CAN transceiver wired to pins 6 and 14 and a K-line on pin 7, so a second bus needs a modified adapter, a cable or a multi-bus STN device. Manufacturer addressing is mostly documented by community reverse engineering and enthusiast tools rather than by the makers, and much of it below is single-source or unconfirmed; every such claim is tagged. Coding, adaptation, key programming and flashing are out of scope for a read-only tool and are mentioned only to say so.

## What an ELM327 can and cannot do (applies to every make)

The ELM327 protocol list covers ISO 9141-2 (5-baud init, 10.4 kbaud), ISO 14230-4 KWP with 5-baud init, ISO 14230-4 KWP with fast init, ISO 15765-4 CAN at 11-bit and 29-bit IDs at 500 and 250 kbaud, J1939, and two user-defined CAN protocols (B at 11-bit with a 125 kbaud default, C at 11-bit with a 50 kbaud default, both user adjustable). Source: the Elm Electronics datasheet, https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf.

The datasheet documents `AT IIA hh` (set the slow-init target address, with the example `AT IIA 7A`, used with protocols 3 and 4), `AT SI` (slow init), `AT FI` (fast init, protocol 5 only), `AT IB 48` and `AT IB 96` (4800 and 9600 baud ISO rates), and `AT SH` for header bytes, with four-byte KWP headers only from ELM327 v1.2 onwards. Same source.

For CAN, `AT CP` sets the five most significant bits of a 29-bit ID and `AT SH` the remaining 24; `AT CRA` or `AT CF`/`AT CM` must define what to receive; `AT FC SH`, `AT FC SD` and `AT FC SM` configure flow control, and `AT CFC0` turns automatic flow control off. Source: https://cdn.sparkfun.com/assets/4/e/5/0/2/ELM327_AT_Commands.pdf and the py-obdii summary at https://py-obdii.readthedocs.io/en/latest/api/modes/mode_at.html.

Hardware limits that matter more than firmware: the ELM327 has a single CAN transceiver on pins 6 and 14, so second-bus modules on other pins are unreachable without hardware changes (see the per-make sections). Ford-style MS-CAN on pins 3 and 11 is documented as needing a modified ELM327 with an HS/MS switch, or an STN11xx adapter with built-in MS-CAN such as the OBDLink EX or MX family: https://forum.forscan.org/viewtopic.php?p=4. That page is about Ford and Mazda; it is the only primary-ish description of the switch technique and is used here as an analogy for JLR, Volvo and Saab pins 3 and 11 (unconfirmed for those makes, since the page does not mention them).

Clones: MultiECUScan's guide says almost all Chinese ELM327 interfaces of a given period had problems on the CAN network that are fixed by removing one resistor, and that the version marking on Chinese units does not match genuine ELM versions: https://www.multiecuscan.net/MultiecuscanUserGuide.pdf. Forum posts on Fiat describe removing a 120 ohm resistor between pins 6 and 7 of the CAN transceiver: https://www.fiatforum.com/threads/multiscan-adapter.479619/page-2. Treat clone behaviour as unpredictable; a genuine ELM or an STN adapter is the safer target for a tool that must be trusted. The OBDLink product pages document MS-CAN and GM SW-CAN support on the MX+ and that the LX cannot read Ford MS-CAN PIDs: https://www.obdlink.com/products/obdlink-mxp/ and https://support.obdlink.com/support/solutions/articles/43000713351 (the second was seen only as a search summary).

Read-only guidance for a tool: a request is read-only if it uses OBD-II modes 01, 02, 03, 07, 09 or manufacturer read services (KWP 0x21, 0x17, 0x18; UDS 0x22, 0x19). Avoid anything that clears codes (mode 04, KWP 0x14, UDS 0x14), starts routines (KWP 0x31, UDS 0x31), changes sessions beyond default or extended-diagnostic, or writes (UDS 0x2E, KWP 0x3B). The CLAUDE.md of this repository also requires that fault codes are not cleared before their history is read, which applies to every vehicle.

## Renault and Dacia

Pins: a pyren-OBD2 compatibility table lists the K-line and L-line pair as pins 7 and 15 for many Clio II, Clio III, Megane II, Scenic II and Modus entries, CAN on pins 6 and 14 on many later ones, a second CAN pair on pins 13 (H) and 12 (L) for some entries, and some Siemens-based ECUs on K at pin 13 and L at pin 12: https://github.com/emtee40/pyren-OBD2. So on Renault the K-line is not always at the J1962 default pin 7, and an ELM327 that only drives pin 7 cannot reach those ECUs. The second CAN pair on 13 and 12 is likewise outside an ELM327's reach (confirmed as a table entry in pyren, bus speed unconfirmed).

K-line era: a Clio Sport forum thread says a Clio 182 uses ISO 14230 (KWP2000) at 10400 baud on the K-line only, while early 172 models use ISO 9141-2 with the L-line involved in initialisation: https://cliosport.net/threads/clio182-obdii-port.174830. This is forum evidence from one vehicle family; treat it as a hint to try protocol 3 and 4 before 5. No source found stated Renault slow-init addresses; the engine ECU address 0x7A that is sometimes quoted for Renault is unconfirmed (no source found), and note that 0x7A appears in the Elm datasheet only as an example for `AT IIA` and in the Volvo 850 page below as the Motronic 4.4 address.

CAN era: ddt4all (https://github.com/cedricp/ddt4all) describes itself as a tool that connects to the CAN network with an ELM327 interface and as mainly aimed at ISO-TP network study; it lists CAN and KWP2000 support and manual ECU requests, and notes that few ELM copies can configure individual CAN addresses (README as summarised through https://github.com/MuratOzturk/ddt4all and https://www.greptile.com/grepository/ddt4all). pyren (https://github.com/emtee40/pyren-OBD2) uses `--can2` for the 13/12 pair, `--si` to try slow init first, and `--cfc` to turn off automatic flow control; it requires the CLIP and DDT2000 databases, which it does not ship. A CanZE issue shows ECU identification requests per address on a Zoe, with 7EC as the response ID used in that case, which is a Zoe-specific ID and not a general table: https://github.com/fesch/CanZE/issues/504.

Cheap-adapter reports: a Megane 3 owner found a cheap ELM327 cable failed with DDT4All while K-line access worked in other software: https://www.motor-talk.de/forum/renault-megane-3-2009-obd-connection-problem-t7268681.html (forum, one case).

Tools that document Renault: Renault CLIP (dealer tool, databases not public), ddt4all, pyren. Car Scanner lists Renault and Dacia among brands with extra connection profiles; what the Renault profile covers was not found: https://apps.apple.com/app/id1259933623 (search summary only).

What ELM327 can do: generic OBD-II on pins 6 and 14 or pin 7, plus manual ISO-TP requests to individual ECUs with `AT SH`, `AT CRA` and `AT FC`. What it cannot: K-line ECUs on pin 13, the 13/12 CAN pair, or anything needing an STN-specific feature the clone lacks.

## PSA (Peugeot, Citroen, DS)

K-line era: an Evoscan pinout page for post-1997 Peugeots lists pin 7 as the K-line for engine and transmission diagnostics, pin 15 as an optional L-line, and pins 6 and 14 as CAN: https://www.evoscan.com/technical-vehicle-manuals/132. A 206 1.4 HDI owner reports an ELM327 connecting to the engine ECU as ISO 14230 with 5-baud init after wiring K and L (pins 7 and 15): https://206info.co.uk/Forums/viewtopic/p=522799.html (forum, seen via search summary). A 2008 207 owner reports from measurement that pin 7 is a direct ISO 14230 link to the engine ECU and pin 12 a second K-line directly to the ABS ECU, and that clearing engine faults via pin 7 avoids the BSI logging it: https://frenchcarforum.co.uk/forum/viewtopic.php?p=853778 (one vehicle, one poster).

CAN era: the same post lists CAN IS on pins 6 and 14, which ServiceBox diagrams call 250 kbit/s but which the poster measured at 500 kbit/s with about 26 IDs, none of which answered UDS requests at the main ECU addresses; and a diagnostic CAN on pins 3 and 8 at 500 kbit/s, which an Actia/Lexia with a Y adapter showed Diagbox to use exclusively: https://frenchcarforum.co.uk/forum/viewtopic.php?p=853766. The arduino-psa-diag README independently gives pin 3 (CAN High) and pin 8 (CAN Low) for AEE2004 and AEE2010 cars and pins 6 and 14 for NEA2020 cars, where those pins also carry DoIP: https://github.com/ludwig-v/arduino-psa-diag. The BSI appears to gate traffic between buses (the forum post says "appears to", so inference).

Addressing: arduino-psa-diag selects an ECU by `EMIT:RECV` CAN IDs entered in hex, with `764:664` as the telematic unit (UDS) and `736:716` as the route to LIN-attached ECUs via UDS; the full ID list is `ECU_LIST.md` in that repository, read for the PSA profiles (see "PSA profiles" below). It documents two KWP2000-over-CAN variants, HAB at 125 kbit/s and IS at 500 kbit/s, plus UDS on newer units. Service IDs it lists: UDS 0x3E, 0x19 02 09 (read faults), 0x14 FF FF FF (clear), 0x10, 0x11, 0x27, 0x22, 0x2E, 0x31, 0x34, 0x37; KWP 0x3E, 0x17 FF 00 (read faults), 0x14 FF 00 (clear), 0x10 C0 and 81, 0x27 81 to 84, 0x21 (read), 0x3B or 0x34 (write), 0x31 A8. Only the read services (0x22, 0x19 02 09, 0x21, 0x17 FF 00, 0x10 session control, 0x3E) are in scope for a read-only tool. Its caution that the transport is a simplified ISO 15765-2 means a standard ISO-TP stack may not match every ECU (stated by the project, not tested here).

ELM327 on PSA: pins 3 and 8 are not reachable by a stock ELM327, so Diagbox-class coverage needs a cable or adapter that exposes the diagnostic CAN. Cheap clones without the right CAN termination are reported failing on C5 and some Peugeot models: https://206info.co.uk/Forums/viewtopic/p=523012.html (forum, summary only). The passive read of pins 6 and 14 in the 207 post shows an ELM327 can sniff CAN IS but, per that poster, the modules there do not answer UDS. Diagbox itself (Lexia/PP2000 interfaces) was not opened; its documentation is proprietary. Third-party coverage: Abrites lists K-line, CAN and UDS support for PSA: https://abrites.com/media/user_manuals/html/abrites-diagnostics-for-psa-user-manual/index.html (seen via search only; coding and key functions out of scope).

### PSA profiles

`psa-uds` and `psa-kwp2000` are built from the sources below, each opened for the profiles on 15 November 2026 with a Wayback snapshot saved the same day (all saves succeeded; the 14-digit timestamp is the capture). Nothing was read from a car.

- `ECU_LIST.md` in arduino-psa-diag, GPL-3.0, copied as facts only: https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/ECU_LIST.md (https://web.archive.org/web/20261115133151/https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/ECU_LIST.md). One row per ECU family with a request and response pair and, for four rows, a LIN selector.
- arduino-psa-diag README, for the pinouts, the KWP2000 variants and the services: https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/README.md (https://web.archive.org/web/20261115133158/https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/README.md).
- arduino-psa-diag sketches, for the bit rate they set: https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/arduino-psa-diag/arduino-psa-diag.ino (https://web.archive.org/web/20261115133205/https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/arduino-psa-diag/arduino-psa-diag.ino) and https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/arduino-psa-diag-low-speed/arduino-psa-diag-low-speed.ino (https://web.archive.org/web/20261115133621/https://raw.githubusercontent.com/ludwig-v/arduino-psa-diag/master/arduino-psa-diag-low-speed/arduino-psa-diag-low-speed.ino).
- PyPSADiag, GPL-2.0, whose `data/ECU_FAMILIES.json` is commented as grabbed from the first project: https://raw.githubusercontent.com/Barracuda09/PyPSADiag/master/README.md (https://web.archive.org/web/20261115133327/https://raw.githubusercontent.com/Barracuda09/PyPSADiag/master/README.md), `data/IdentKWPECU.json` (https://web.archive.org/web/20261115133421/https://raw.githubusercontent.com/Barracuda09/PyPSADiag/master/data/IdentKWPECU.json) and `data/IdentUDSECU.json` (https://web.archive.org/web/20261115133425/https://raw.githubusercontent.com/Barracuda09/PyPSADiag/master/data/IdentUDSECU.json). The two ident files are identifier tables (one-byte local identifiers 0x80 to 0x82 and 0xFE for KWP2000, two-byte data identifiers such as 0xF080 and 0xF18C for UDS), not a classification of units. What does classify them is the `json/<family>/<ecu>.json` directory, one file per ECU model with `tx_id`, `rx_id` and `protocol` (`uds`, `kwp_hab` or `kwp_is`), listed through the GitHub API and read for those three fields; one file has a snapshot, https://web.archive.org/web/20261115133617/https://raw.githubusercontent.com/Barracuda09/PyPSADiag/master/json/MATT/MATT2010.json, and the rest were read from the same branch on the same day without one.
- A ServiceBox forum post on a 2008 207cc, one vehicle and one poster: https://frenchcarforum.co.uk/forum/viewtopic.php?p=853766 (https://web.archive.org/web/20261115133435/https://frenchcarforum.co.uk/forum/viewtopic.php?p=853766).

Why two profiles. A profile holds one protocol, and the protocol belongs to the ECU model, not the identifier: PyPSADiag lists 765:665 as a `kwp_hab` file (EMF_A, EMF_C) and as a `uds` file (EMF_C_UDS), and 772:672 and 77C:67C as both. The ECU list repeats the same ID under families such as BMF_UDS_PSA and BMF_K_PSA. Splitting by architecture (AEE2004, AEE2010, NEA2020) is not possible because no source tags a pair with an architecture. A per-unit protocol in the schema would not help either, since the protocol cannot be set per row from the evidence. So `psa-uds` (UDS, default session) holds each pair PyPSADiag lists as `uds` and each pair no source gives a protocol for, and `psa-kwp2000` (KWP2000, session 0x81) holds each pair PyPSADiag lists as `kwp_is` (only 6B5:695, the DIRECTN family's DAE_BVH2 file) and the same unknown-protocol pairs. A pair PyPSADiag lists only as `uds` is not in `psa-kwp2000`. A unit silent under one profile may answer under the other, and `obd-read probe` shows which.

Reported by the sources, not checked on a car: every address pair, the pins, the protocols and the bit rates. Checked here: that the profiles load and pass `profile check`, that each pair is used once per profile, and that a scripted adapter and car answer through every row; that says nothing about a PSA car. Twenty-seven of the table's pairs also appear in a PyPSADiag ECU file, which is the only corroboration, and it is not independent for the family table.

Contradictions and open points, recorded in the profile notes and tracked by [issue 38](https://github.com/Mearman/obd/issues/38):

- Diagnostic CAN bit rate. The arduino-psa-diag sketch sets 500 kbit/s for the "Diagnostic CAN bus - High Speed" and its low-speed sketch 125 kbit/s for the "Entertainment CAN bus - Low Speed"; the README labels the KWP2000 variants "HAB - 125Kbits" and "IS - 500Kbits". The forum post says ServiceBox shows the CAN IS on pins 6 and 14 at 250 kbit/s, which the poster measured at 500 kbit/s with about 26 identifiers, and the diagnostic CAN on pins 3 and 8 at 500 kbit/s. So the two values reported (250 and 500) are for the bus on pins 6 and 14, and no source opened gives 250 kbit/s for the diagnostic CAN. The profiles use 500 kbit/s.
- NEA2020 pins. The arduino-psa-diag README says the original pins 6 and 14 carry DoIP on NEA2020 cars, and the PyPSADiag README says the diagnostic CAN is on pins 6 and 14 there and needs no adapter. A DoIP link is Ethernet, which this tool cannot reach; whether classic CAN diagnostics also answer on pins 6 and 14 is unsettled.
- AEE2004 and AEE2010 use pins 3 and 8, so an ELM327 or STN adapter needs a pass-through adapter or cable (both READMEs). The PyPSADiag README names AEE2010 only, and advises a branded adapter with a genuine MAC address over a clone; the arduino-psa-diag README gives the same pins for both architectures.
- PyPSADiag's RTBM file uses 77C:77F where the table gives 77C:67C for the MDS family.
- The arduino-psa-diag README opens its UDS session with 10 03 in its answer table and labels `1003` "Coding" in its unlock table, so the profile opens the default session and leaves 0x03 to the user.
- The sources name no brand. Peugeot, Citroen and DS follow from the tools being for PSA; Opel and Vauxhall on PSA platforms are by platform and unconfirmed.

Excluded, with the reason:

- Pairs PyPSADiag lists only as `kwp_hab`: 744:644 (AIRBAG), 760:660 (AUTORADIO), 77D:67D (AMPLHIFI) and 6C4:604 (BECB, BECB_VE). The guard's read-only KWP2000 list allows sessions 0x81 and 0x92 and the README opens HAB with 0xC0, and HAB is the 125 kbit/s variant.
- 6B4:000 (AVM_RAWCAN): a response identifier of 0x000 is not a reply.
- LIN-attached units are reachable only through a LIN selector (L47, L48, L68, L70) this tool cannot send, so those rows reach the gateway unit only.
- Pairs that reuse a request or response identifier another pair already holds, which `profile check` rejects because a reply could not be attributed. The pair that keeps the identifier is the first of: a pair PyPSADiag lists, a pair whose response is the request minus 0x100 or 0x20, then table order. This ordering is a choice made here, not something a source states. The losers are 733:73B (EDL), 720:728 (BSP), 761:762 (BMU), 765:568 (OBC), 751:752 (SUPERVISEUR), 64E:64F, 65E:65F, 66E:66F, 68E:68F and 6BE:6BF (CMU_04, CMU_05, CMU_06, CMU_08 and CMU_11), 771:772 (CLIM_COMP), 7B0:7C3 and 7B0:7DB (COMBINE_CAN_FIAT, SUSPVAR), 773:774 (OSS), 758:759 (DARA), 750:758 (AUTDEM, BML_ES, CSP) and, in `psa-kwp2000` only, every pair PyPSADiag lists only as `uds`. A pair that loses here can still be the right one on a car with that unit; `obd-read discover` or a hand-written profile reaches it.
- 77C:77F (PyPSADiag RTBM), which would reuse request 77C.
- The table's rows named for Mitsubishi (MMC), Fiat and CQCA vehicles are kept where they do not conflict, because the sources do not say they fall outside PSA-badged cars; they are named by family in their descriptions.
- Coding, adaptation, flashing and every other write and security-access service in the sources are out of scope, as above.

## Fiat, Alfa Romeo, Lancia

MultiECUScan (https://www.multiecuscan.net/MultiecuscanUserGuide.pdf) supports KL/VAG-COM 409 K-line cables, ELM327 (v1.3 or newer required for CAN), OBDKey, OBDLink, ELM Scan 5 and CANtieCAR. Per its guide: a K-line cable cannot reach the vehicle CAN network; an ELM327 reaches all supported modules except most old airbag modules and some old ABS and engine modules; ABS, airbag, power steering and xenon modules, and most modules in Grande Punto, Punto Evo, 500, Mito and some Doblo, need an adapter cable or a modified interface. Its vehicle list says which cable applies: http://www.multiecuscan.net/SupportedVehiclesList.aspx (link given in the guide, not opened).

Buses: a MultiECUScan forum post maps high-speed CAN (CAN C, pins 4 and 16) to engine, ABS and power steering and low-speed CAN (CAN B, pins 1 and 9) to other modules, and the AlfaOBD help says B-CAN is on pins 1 and 9 on Fiat 500 cars and warns against a K-line-tied modified interface on Mito, Giulietta, 500, 500L, Grande Punto, Punto Evo and Ducato 250: https://multiecuscan.net/forum/viewtopic.php?p=4447 and https://www.scribd.com/document/410108630/AlfaOBD-Android-Help (both seen via search summaries only). A forum poster on a Grande Punto says only CAN on pins 6 and 14 and power are wired to the OBD port there, with pin 7 K-line unused: https://www.fiatforum.com/threads/multiscan-adapter.479619/page-2. These two accounts differ by model and bus, which fits the guide's statement that the cable requirement depends on the car.

Bus speeds: the query asked for 500 kbit/s versus 50 kbit/s. The 500 kbit/s figure for the Fiat 500 is supported by talking-with-cars notes (29-bit IDs at 500 kb/s, requests in the form 0x18DAxxF1 with xx 0x10 engine, 0x28 ABS, 0x30 steering column and 0x40 body, UDS 0x10 then 0x22): https://github.com/P1kachu/talking-with-cars/blob/master/notes/fiat-500.txt. No source found stated the B-CAN bit rate, so a 50 kbit/s body bus is unconfirmed. The ELM327 datasheet's user protocol C defaults to 50 kbaud and is user adjustable (Elm datasheet above), so it is a plausible configuration but only on whatever pins the adapter's transceiver is wired to.

Older K-line era: MultiECUScan covers engine, gearbox and older ABS and airbag ECUs over K-line with a plain KL cable (guide above); the specific KWP addresses are not given in the guide.

Security gateway: Fiat-group vehicles from the 2018 model year onwards (sold from mid-2017 per forum members) are described as having an SGW that limits OBD diagnostic access to read-only unless the tool authenticates through the manufacturer: https://www.fiatforum.com/threads/fait-500-multiecuscan-problems-accessing-ecus-via-yellow-can-adaptor-cable.485154/latest (forum, search summary). A tool vendor says the SGW restricts code clearing, special functions, active tests and relearns, and that registered repairers can unlock it from 2018: https://www.klavkarr.com/blog/security-gateway-alfa-romeo (vendor, the page itself did not detail Alfa functions). Whether generic OBD-II reads pass on a given Alfa is unconfirmed; a read-only tool is least affected but should expect missing modules rather than errors.

Interface advice from users: the MultiECUScan forum and Fiat forum recommend OBDLink-class or genuine ELM adapters over clones, and the MultiECUScan faulty-ELM thread is the community reference (https://multiecuscan.net/forum/viewtopic.php?p=22782 returned 404 when fetched, so its content was not read).

## Volvo

Platform notes first. P80 (850, S70, V70 up to about 1998 to 2000): an ISO 9141-2 style K-line at 10400 baud on pin 7 with keyword D3 B0, reached with `ATSP 3` and slow-init addresses per module. Jones's pages document it in detail with an ELM327: https://jonesrh.info/volvo850/elm327_volvo_850_svc70_scan.html and https://jonesrh.info/volvo850/volvo850diag.html. Module slow-init addresses from those pages (for `AT IIA`): COMBI 51, SRS 58, ABS 01, AW 50-42 transmission 6E, Motronic 4.4 7A, MSA 15.7 91 (older notes 11), immobiliser C1 (older notes 41), ECC 29. Commands to set the headers are of the form `ATSH 83 xx 13` (DTC reads), `ATSH 84 xx 13` (live data, freeze frame) with `ATWM 82 xx 13 A1` as the init message; ELM327 v1.4 or later is advised, and OBD-II PIDs return NO DATA on some cars. These are enthusiast results for 1996 to 1998 cars and should not be generalised. The author notes that some ECUs (Motronic 4.3, Fenix 5.2, LH 3.2) do not accept KWPD3B0. Volvo's name for this bus, "D2", was searched for and not found in any opened source, so that mapping is unconfirmed.

P1 (S40, V50, C30, C70 from 2006): a Volvo training PDF describes a high-speed CAN at 500 kbps and a low-speed CAN at 125 kbps with the CEM adapting speed between them, and says VIDA diagnostics run on the high-speed side through the CEM: https://automotivetechinfo.com/wp-content/uploads/2021/01/Understanding-Volvo-Networks-and-Wiring.pdf (text extracted from the PDF locally; some wording in the extraction is incomplete). A C30 CAN-bus page wires high-speed CAN to OBD pins 6 and 14 at 500 kbit/s and low-speed to pins 3 and 11 (bit rate not given), and uses 29-bit IDs for broadcast frames: https://paul.sullivan.za.org/volvo-c30-1.6d/OBD-II_CAN-bus/. It does not say how ECUs are addressed for diagnostics.

P2 (S60, S80, V70 XC70 XC90, 1999 to 2007 range): the VIDA protocol uses CAN ID 0x000FFFFE as a request ID reserved for diagnostic devices, with a recipient address in one of the data bytes, and VIDA shows the same device addresses across a MY2009 XC90, MY2005 S80, MY2002 S60 and C40, for example AEM 0x52, BCM 0x01 and CCM 0x29: https://hackingvolvoxc90.blogspot.com/2018/01/all-about-dominance-and-being-hidden-in.html (one author's reverse engineering). A VIDA log analysis page describes the request frame as length byte (0xC8 plus data length), module ID, operation type (0xA6 read, with 0xE6 as reply), a two-byte operation ID and a response count, for example `CD 50 A6 1A 04 01 00 00` for the ignition key position from the CEM (module 0x50): https://jan-jansen.readthedocs.io/en/latest/volvo-diagnostic.html (the author labels these as inferred, and says the reply ID 0x01200021 is a guess). Neither source says KWP or UDS, so naming the protocol is unconfirmed. A high-speed CAN speed of 250 kbit/s up to model year 2004 and 500 kbit/s from 2005 is claimed in a repair manual snippet seen only in search results: https://manuals.autorepairshq.com/Volvo/2005/S60%20L5-2.4L%20VIN%2061%20B5244S/Repair%20and%20Diagnosis/Accessories%20and%20Optional%20Equipment/Entertainment%20Systems/Testing%20and%20Inspection (unconfirmed, not opened).

P3 (XC60, S60 and V60 later, XC70 and S80 from 2008): a 2013 XC60 service manual snippet puts pins 3 and 11 as mid-speed CAN at 125 kbit/s and pins 6 and 14 as high-speed CAN at 500 kbit/s, consistent with a Snap-on article on an XC60 mid-speed bus fault: https://www.vehicleservicepros.com/service-repair/the-garage/blogs/blog/21238728/snapon-diagnostics-mid-speed-can-bus-failure-on-a-volvo-xc60 (both seen via search summary only). One forum thread gives 11-bit IDs 0x726/0x72E for the CEM and 0x7E0/0x7E8 for the ECM with 0x7DF functional on a V40, and 29-bit IDs on later models such as the XC60 with the ECM at 0x1630: https://forums.spaycetech.com/showthread.php?tid=647 (single forum source, search summary, unconfirmed for P2 and P3).

CEM gateway: the CEM adapts traffic between the low-speed and high-speed CAN and is the entry point for VIDA/DiCE diagnostics on P1 (training PDF above). An older S80 manual says to check the cables between diagnostic outlet pins 3 and 11 and the CEM when low-speed units fail, implying pins 3 and 11 reach the CEM directly (manual snippet, search only).

ELM327: it can sit on pins 6 and 14 for powertrain OBD-II; pins 3 and 11 need a switch or a dual-bus STN adapter. Whether an STN adapter's MS-CAN mode (documented for Ford and GM) works at 125 kbit/s on Volvo is unconfirmed. DiCE and VIDA (Volvo's dealer tool) documentation was not opened.

## Jaguar and Land Rover

JLR documentation was the thinnest of any make searched. Jaguar and Land Rover are listed among brands using a "3-11" CAN connection in a telematics installation manual (an installation guide, not a diagnostic reference): https://targatelematics.com/wp-content/uploads/2025/12/ARTEL_InstallationManual_Kit1R_generico_REV01_09.10.2025.pdf. Land Rover forum posts describe measuring about 60 ohm between pins 6 and 14 and between pins 3 and 11 to check each bus: https://landroverforums.com/forum/lr3-28/problem-voltage-bus-can-system-62008 (search summary). The FORScan pages are about Ford but describe the same pin pair and ELM327 modification (see the ELM327 section above).

Vendor summaries say the older JLR VCI interface covers CAN, ISO 9141 and SCP vehicle networks, and that the DoIP VCI is needed for later vehicles with the Pathfinder software and for SDD on 2005 to 2017 model years (retailer pages; inconsistent between vendors): https://techroute66.com/product/jlr-vci-for-jaguar-and-land-rover/ and https://www.hickleys.com/diagnostics/jlr.php. JLR's own TOPIx pages say SDD covers vehicles to about 2018 and TOPIx Cloud covers later ones (search summary; the specific page was not opened): https://topix.landrover.jlrext.com/topix/service/procedure/1797561/ODYSSEY_GENERIC/G4732184/en_US. Snap-on lists DoIP support for Land Rover from 2018 and the I-Pace: https://www.snapon.com/EN/UK/Diagnostics/Diagnostics/Platforms/EthernetDoIP-Communications.htm (search summary).

Known community CAN-ID collections: iDoka's list links Land Rover Freelander 2, Discovery 3 and Range Rover L322 pages and Jaguar XJ and XF X250 entries, mostly drive2.ru posts and one GitHub repository: https://www.github.com/iDoka/awesome-automotive-can-id (only the index was read; the linked pages were not opened, so no JLR IDs are quoted here). A 1998 Jaguar XJR thread says only the K-line is needed for OBD-II communication on that car: https://diag.net/discussion/smeyzxqeshdehyxq1tgfrhr4ei (anecdotal).

What can be stated: JLR mid-2000s to 2017 cars have a standard OBD-II HS-CAN on pins 6 and 14 and, per the pin-pair evidence above, an MS-CAN pair on pins 3 and 11 (the bus speed and the modules on it are unconfirmed for JLR). Later DoIP vehicles need an Ethernet interface, which an ELM327 cannot provide. JLR MS-CAN module IDs, K-line init addresses for X-type, S-type and Freelander 1 are not documented in any source found and are unconfirmed.

## Saab

Saab data was searched because it was in the brief. Older Saabs (9-3 9400 and 9-5 9600) used proprietary buses behind the DLC: the 2002 9-3 WIS page describes the diagnostic tool calling DICE, which relays over the I-bus to MIU, which relays over the P-bus to the TCM, with the TC/ABS module reached over K-line and pin 7 and pin 8 as communication leads for specific modules: https://saabwisonline.com/9-3-9400/2002/3-electrical-system/bus-and-diagnostics-communication/technical-description/diagnostics-communication. A Trionic T5 page says the control module talks via pin 33 and a K-lead through the MIU: https://saabwisonline.com/9-3-9400/1998/2-engine/trionic-t5-obdii/technical-description/diagnostics-communication.

Later GM-derived platforms (9-3 from 2003, 9-5 9650 from 2010): the 2011 9-5 WIS page documents high-speed GMLAN up to 500 kb/s on pins 6 and 14, a chassis high-speed GMLAN on pins 12 and 13, mid-speed GMLAN on pins 3 and 11, low-speed single-wire GMLAN on pin 1 at up to 83.33 kb/s (normally 33.33), and the BCM as the gateway between high-speed and low-speed: https://saabwisonline.com/9-5-9650/2011/3-electrical-system/bus-and-diagnostics-communication/technical-description/data-link-communications-description-and-operation. That page is for one model and year; its pin assignment is not confirmed for the 2003 to 2009 9-3 (a parts-seller guide and a forum post on a 2005 9-3 put single-wire CAN on pin 1, consistent but weak: https://www.go-parts.com/garage/obd-u0100-saab-9-3-2003-2012). A rate of 47.6 kbit/s for a Saab bus was in the brief and no source supported it, so it is unconfirmed. An ELM327 on pins 6 and 14 reaches the high-speed GMLAN; pin 1 single-wire and pins 3 and 11 need adapters with SW-CAN and MS-CAN support (OBDLink MX+ documents GM SW-CAN: https://www.obdlink.com/products/obdlink-mxp/).

## Cross-cutting design notes for obd-read

First, probe by protocol and pin before by make. Try the ELM327 auto search (`AT SP 0`), then explicit protocols 3, 4 and 5 for K-line cars, noting that fast init (protocol 5) and 5-baud init (protocols 3 and 4) both exist and that some ECUs need `AT IIA` and `AT SI` or `AT FI` issued separately with a delay, as the datasheet describes.

Second, treat second-bus modules as an adapter capability and report them as "not reachable with this adapter" rather than "no response". The pins that matter are PSA 3 and 8, Fiat 1 and 9, Volvo and Saab 3 and 11, JLR 3 and 11, Renault 13 and 12, and ISO K-lines at pins 12 or 13 on some PSA and Renault cars.

Third, expect gateways to drop or ignore diagnostic traffic. The PSA BSI, the Volvo CEM, the Saab BCM and the 2018-and-later FCA SGW all sit between the OBD pins and ECUs on other buses. A read of a module that does not answer is not proof the module is absent.

Fourth, keep the manufacturer address tables as data, sourced and tagged. Most of what is documented is per-vehicle (the Volvo 850 addresses, the Fiat 500 0x18DAxxF1 scheme, the PSA `EMIT:RECV` pairs, the Zoe 7EC response) and should be shipped as optional, labelled profiles, not defaults.

Fifth, interfaces: user reports prefer OBDLink or genuine ELM interfaces over clones for Fiat and Alfa, and the Car Scanner connection profiles and OBD Fusion manufacturer add-ons are the commercial equivalents of the profile data above (OBD Fusion lists were not opened; OBDLink states that its manufacturer-specific add-ons beyond the generic set are not guaranteed on other adapters: https://support.obdlink.com/support/solutions/articles/43000711154, search summary).

## Out of scope

Coding, adaptations, key and immobiliser programming, security-access seed and key (UDS 0x27), routine control (0x31), data writes (0x2E, KWP 0x3B), ECU reflashing (0x34 to 0x37) and clearing fault codes are not part of a read-only tool. They are mentioned in the sources (arduino-psa-diag, Diagbox, VIDA, SDD, Clip) and deliberately not documented here.

## Sources read and their limits

Opened and read for the PSA profiles: the arduino-psa-diag `ECU_LIST.md`, README and both sketches, the PyPSADiag README, ident files and ECU model files, and one forum post, listed under "PSA profiles". Opened and read: the Elm Electronics ELM327 datasheet (via local PDF text), the MultiECUScan user guide (via local PDF text), the Volvo networks training PDF (via local PDF text, partly garbled), arduino-psa-diag README, pyren-OBD2 README, ddt4all README (cedricp), Jones's Volvo 850 pages, the Volvo VIDA reverse-engineering blog pages, the French car forum 207 posts, FORScan MS-CAN page, talking-with-cars Fiat 500 notes, the C30 CAN-bus page, Saab WIS 2002 9-3 and 2011 9-5 pages, the Fiat forum threads, klavkarr SGW pages, the iDoka CAN-ID index.

Opened later and now read: the Snap-on XC60 article (https://www.vehicleservicepros.com/service-repair/the-garage/blogs/blog/21238728/snapon-diagnostics-mid-speed-can-bus-failure-on-a-volvo-xc60 confirms pins 3 and 11 as the mid-speed CAN at about 125 kbit/s, and does not name the high-speed pins), the OBDLink support table (https://support.obdlink.com/support/solutions/articles/43000713351 lists MS-CAN on the MX+ and EX, SW-CAN on the MX+ only, and neither on the CX and LX), and the remainder of the Volvo 850 diagnostic page (it confirms tester address 13, ATSH 83 51 13 style headers and that OBDLink devices use ATKW rather than ATBD to verify slow init).

Still unread: https://multiecuscan.net/forum/viewtopic.php?p=4447 returns 404, and the XC60 service manual page failed with a closed socket on retry, so the XC60 pin and speed claim rests on the Snap-on article plus a manual snippet. The remaining items below were seen only as search summaries and not retried: the Scribd AlfaOBD help, the Abrites PSA manual, the 206info and frenchcarforum clone threads, the other Volvo repair-manual snippets, the JLR vendor and TOPIx pages, the Land Rover forum thread, the Car Scanner App Store page, and the cliosport and motor-talk threads. No proportionate check can settle them further without those pages being reachable.

## Archived copies

Latest Wayback Machine snapshot found for each cited page. Pages with no snapshot are listed after.

- http://www.multiecuscan.net/SupportedVehiclesList.aspx (http://web.archive.org/web/20260316222817/https://www.multiecuscan.net/SupportedVehiclesList.aspx)
- https://apps.apple.com/app/id1259933623 (http://web.archive.org/web/20230105124224/https://apps.apple.com/app/id1259933623)
- https://automotivetechinfo.com/wp-content/uploads/2021/01/Understanding-Volvo-Networks-and-Wiring.pdf (http://web.archive.org/web/20240901042314/https://automotivetechinfo.com/wp-content/uploads/2021/01/Understanding-Volvo-Networks-and-Wiring.pdf)
- https://cdn.sparkfun.com/assets/4/e/5/0/2/ELM327_AT_Commands.pdf (http://web.archive.org/web/20261013183901/https://cdn.sparkfun.com/assets/4/e/5/0/2/ELM327_AT_Commands.pdf)
- https://cliosport.net/threads/clio182-obdii-port.174830 (http://web.archive.org/web/20210117190842/https://cliosport.net/threads/clio182-obdii-port.174830/)
- https://github.com/P1kachu/talking-with-cars/blob/master/notes/fiat-500.txt (http://web.archive.org/web/20260222183059/https://github.com/P1kachu/talking-with-cars/blob/master/notes/fiat-500.txt)
- https://github.com/cedricp/ddt4all (http://web.archive.org/web/20260915080933/https://github.com/cedricp/ddt4all)
- https://github.com/emtee40/pyren-OBD2 (http://web.archive.org/web/20240818100647/https://github.com/emtee40/pyren-OBD2)
- https://github.com/ludwig-v/arduino-psa-diag (http://web.archive.org/web/20260223224320/https://github.com/ludwig-v/arduino-psa-diag)
- https://github.com/Barracuda09/PyPSADiag (snapshots of the specific files read are under "PSA profiles")
- https://hackingvolvoxc90.blogspot.com/2018/01/all-about-dominance-and-being-hidden-in.html (http://web.archive.org/web/20241225192917/https://hackingvolvoxc90.blogspot.com/2018/01/all-about-dominance-and-being-hidden-in.html)
- https://jonesrh.info/volvo850/volvo850diag.html (http://web.archive.org/web/20211203155455/https://jonesrh.info/volvo850/volvo850diag.html)
- https://landroverforums.com/forum/lr3-28/problem-voltage-bus-can-system-62008 (http://web.archive.org/web/20150106161540/http://landroverforums.com:80/forum/lr3-28/problem-voltage-bus-can-system-62008/)
- https://support.obdlink.com/support/solutions/articles/43000711154 (http://web.archive.org/web/20260722203855/https://support.obdlink.com/support/solutions/articles/43000711154)
- https://support.obdlink.com/support/solutions/articles/43000713351 (http://web.archive.org/web/20260722203855/https://support.obdlink.com/support/solutions/articles/43000713351)
- https://techroute66.com/product/jlr-vci-for-jaguar-and-land-rover/ (http://web.archive.org/web/20260721192858/https://techroute66.com/product/jlr-vci-for-jaguar-and-land-rover)
- https://www.github.com/iDoka/awesome-automotive-can-id (http://web.archive.org/web/20260901132908/https://github.com/iDoka/awesome-automotive-can-id)
- https://www.greptile.com/grepository/ddt4all (http://web.archive.org/web/20260610003356/https://www.greptile.com/grepository/ddt4all)
- https://www.hickleys.com/diagnostics/jlr.php (http://web.archive.org/web/20251116161619/https://www.hickleys.com/diagnostics/jlr.php)
- https://www.klavkarr.com/blog/security-gateway-alfa-romeo (http://web.archive.org/web/20260610184726/https://www.klavkarr.com/blog/security-gateway-alfa-romeo)
- https://www.motor-talk.de/forum/renault-megane-3-2009-obd-connection-problem-t7268681.html (http://web.archive.org/web/20231230235523/https://www.motor-talk.de/forum/renault-megane-3-2009-obd-connection-problem-t7268681.html)
- https://www.multiecuscan.net/MultiecuscanUserGuide.pdf (http://web.archive.org/web/20260616093339/https://www.multiecuscan.net/MultiecuscanUserGuide.pdf)
- https://www.obdlink.com/products/obdlink-mxp/ (http://web.archive.org/web/20261012021255/https://www.obdlink.com/products/obdlink-mxp/)
- https://www.scribd.com/document/410108630/AlfaOBD-Android-Help (http://web.archive.org/web/20260307195831/https://www.scribd.com/document/410108630/AlfaOBD-Android-Help)
- https://www.snapon.com/EN/UK/Diagnostics/Diagnostics/Platforms/EthernetDoIP-Communications.htm (http://web.archive.org/web/20260716021525/https://www.snapon.com/EN/UK/Diagnostics/Diagnostics/Platforms/EthernetDoIP-Communications.htm)

No snapshot found:

- https://206info.co.uk/Forums/viewtopic/p=522799.html
- https://206info.co.uk/Forums/viewtopic/p=523012.html
- https://abrites.com/media/user_manuals/html/abrites-diagnostics-for-psa-user-manual/index.html
- https://diag.net/discussion/smeyzxqeshdehyxq1tgfrhr4ei
- https://forum.forscan.org/viewtopic.php?p=4
- https://forums.spaycetech.com/showthread.php?tid=647
- https://frenchcarforum.co.uk/forum/viewtopic.php?p=853766
- https://frenchcarforum.co.uk/forum/viewtopic.php?p=853778
- https://github.com/MuratOzturk/ddt4all
- https://github.com/fesch/CanZE/issues/504.

Cheap-adapter

- https://jan-jansen.readthedocs.io/en/latest/volvo-diagnostic.html
- https://jonesrh.info/volvo850/elm327_volvo_850_svc70_scan.html
- https://www.evoscan.com/technical-vehicle-manuals/132
- https://manuals.autorepairshq.com/Volvo/2005/S60%20L5-2.4L%20VIN%2061%20B5244S/Repair%20and%20Diagnosis/Accessories%20and%20Optional%20Equipment/Entertainment%20Systems/Testing%20and%20Inspection
- https://multiecuscan.net/forum/viewtopic.php?p=22782
- https://multiecuscan.net/forum/viewtopic.php?p=4447
- https://paul.sullivan.za.org/volvo-c30-1.6d/OBD-II_CAN-bus/
- https://py-obdii.readthedocs.io/en/latest/api/modes/mode_at.html.

Hardware

- https://saabwisonline.com/9-3-9400/1998/2-engine/trionic-t5-obdii/technical-description/diagnostics-communication.

Later

- https://saabwisonline.com/9-3-9400/2002/3-electrical-system/bus-and-diagnostics-communication/technical-description/diagnostics-communication
- https://saabwisonline.com/9-5-9650/2011/3-electrical-system/bus-and-diagnostics-communication/technical-description/data-link-communications-description-and-operation
- https://targatelematics.com/wp-content/uploads/2025/12/ARTEL_InstallationManual_Kit1R_generico_REV01_09.10.2025.pdf
- https://topix.landrover.jlrext.com/topix/service/procedure/1797561/ODYSSEY_GENERIC/G4732184/en_US
- https://www.fiatforum.com/threads/fait-500-multiecuscan-problems-accessing-ecus-via-yellow-can-adaptor-cable.485154/latest
- https://www.fiatforum.com/threads/multiscan-adapter.479619/page-2
- https://www.go-parts.com/garage/obd-u0100-saab-9-3-2003-2012
- https://www.scantool.net/scantool/downloads/103/elm327dsh.pdf.

The

- https://www.vehicleservicepros.com/service-repair/the-garage/blogs/blog/21238728/snapon-diagnostics-mid-speed-can-bus-failure-on-a-volvo-xc60

## Links that did not load when checked

These pages returned an error or no response when the links were checked. Claims resting only on them are less certain.

- https://206info.co.uk/Forums/viewtopic/p=522799.html
- https://206info.co.uk/Forums/viewtopic/p=523012.html
- https://manuals.autorepairshq.com/Volvo/2005/S60%20L5-2.4L%20VIN%2061%20B5244S/Repair%20and%20Diagnosis/Accessories%20and%20Optional%20Equipment/Entertainment%20Systems/Testing%20and%20Inspection
- https://multiecuscan.net/forum/viewtopic.php?p=22782
- https://multiecuscan.net/forum/viewtopic.php?p=4447
