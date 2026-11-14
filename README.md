# obd-read

Read a car's diagnostics through an ELM327-style adapter, with software you can read and change.

`obd-read` talks to the control units behind the diagnostic socket: it reads their identification, stored fault codes and freeze frames. It can also clear a unit's fault codes, after saving what it is about to erase. It has no actuator tests, coding, writes or flashing, and no setting that adds them.

## What it needs

- An adapter that implements the full ELM327 command set, reached over Bluetooth LE, a serial port (USB or classic Bluetooth) or TCP (Wi-Fi adapters), or a raw CAN adapter reached over SocketCAN or SLCAN. Cheap clones that lack the addressing commands are detected and named on connection. Standard `AT` commands are used throughout; on connection the tool also reports whether the adapter has the STN `ST` extensions, which it uses only where a plain ELM327 cannot do the job (see [Bit rates](#bit-rates) and [Requests longer than one frame](#requests-longer-than-one-frame)) and in the [bus monitor](#bus-monitor).
- [uv](https://docs.astral.sh/uv/).
- For anything beyond the legislated OBD-II reads, a vehicle profile. The profiles shipped are in [`src/obd_read/profiles`](src/obd_read/profiles).

## Getting started

```sh
uv sync
uv run obd-read adapters
```

`adapters` lists the Bluetooth LE devices in range and the serial ports present. Name the adapter by URL on every other command:

| Link | URL |
|---|---|
| Bluetooth LE | `ble://<part of the device name, or its address>` |
| Serial | `serial:///dev/tty.usbserial-1` (add `?baud=38400` to change the speed) |
| TCP | `tcp://192.168.80.1:35000` |
| SocketCAN (Linux) | `socketcan://can0` |
| SLCAN serial | `slcan:///dev/ttyACM0` (add `?baud=921600` to change the speed) |

The first four reach an ELM327-style adapter. The last two reach a raw CAN adapter, described in [Raw CAN adapters](#raw-can-adapters).

First run at a car, ignition on:

```sh
uv run obd-read probe --adapter ble://vLinker --profile mercedes-w211 --log first-run.log
```

`probe` asks every unit in the profile to identify itself and prints which answered. Nothing else is sent.

## Commands

| Command | What it reads |
|---|---|
| `adapters` | Bluetooth LE devices and serial ports. `--inspect <name>` prints one device's services and characteristics. |
| `probe` | Which units in the profile answer. |
| `ident <unit>` | One unit's identification. |
| `faults <unit>` | One unit's stored fault codes and status bytes. |
| `freeze <unit>` | The freeze frame stored with each fault code. |
| `scan` | Identification and fault codes from every unit. `--output <path>` writes `<path>.json` and `<path>.md`; `--freeze` adds freeze frames. |
| `obd` | Legislated OBD-II reads that need no profile: VIN, warning-lamp state, stored, pending and permanent codes, a few live values. `--kline <scheme>` reads over K-line instead of CAN. |
| `clear-codes --save <file>` | Erases the codes of every emissions unit, with no profile. See below. |
| `request <unit> <hex>` | One request of your choosing, for example `1A86`. Only read-only services are sent. |
| `discover --protocol <kwp2000\|uds>` | For a car with no profile: asks each 11-bit CAN request identifier in `--first` to `--last` (default `0x700` to `0x7FF`) to open the default session, and lists which answer and from which identifier. `--output <file>` writes the answers as an unconfirmed draft profile, named `--name`, for `profile check`. Only the guarded default-session request is sent, but every silent identifier waits out the adapter's reply timeout, so narrow the range when you can. Takes no `--profile`. |
| `simulate --profile <profile>` | Serves a scripted adapter and car over TCP on `127.0.0.1:35000` (`--host`, `--port`), so the tool and a profile can be tried with no car: `obd-read probe --adapter tcp://127.0.0.1:35000 --profile <profile>`. Every unit in the profile answers with one invented fault code, and each connection starts a fresh car, so `clear` can be tried safely. It connects to nothing. |
| `profile check <profile>...` | Validates profile files (or shipped names) without connecting to anything; exits 1 on any problem. |
| `monitor` | Logs CAN traffic without transmitting. See [Bus monitor](#bus-monitor). |
| `clear <unit> --save <file>` | Erases one unit's stored fault codes. See below. |
| `compare <first> <second>` | Two saved scans side by side. Needs no adapter. See below. |
| `describe <scan or code>...` | Names for fault codes. Needs no adapter. See below. |
| `import-names <file> --unit <name> --output <file>` | Code and request names from a definition file you supply. Needs no adapter. See below. |

Every command that talks to a car takes `--adapter`, and `--log <file>` to keep the full exchange with the adapter. All except `obd`, `discover` and `clear-codes` take `--profile`.

Fault codes are printed as the unit reports them: hexadecimal code bytes and a status byte. `describe` adds names to them afterwards.

## Comparing scans

`obd-read compare before.json after.json` takes two files written by `scan --output` (or the snapshot `clear --save` writes) and prints, per unit, the fault codes that appeared, cleared or changed status, the units that started or stopped answering, and any change to a stored freeze frame or identification value. Fault codes are compared only for a unit whose codes both scans read. Units with no difference are not listed.

## Naming fault codes

`describe` looks codes up in three places, most specific first, and prints where each name came from:

- The `[codes.<unit>]` tables of the profile, for the hexadecimal codes a unit reports. Each entry needs `text` and a `source`, and no shipped profile has entries yet because none has been confirmed against a source:

  ```toml
  [codes.esp."5123"]
  text = "what the source says this code means"
  source = "where it says so"
  ```

- Names imported with `import-names` and passed with `--names <file>`.
- For SAE codes such as `P0420` (the codes `obd` prints), the generic OBD-II titles in [`src/obd_read/data/obdex-generic.tsv`](src/obd_read/data/obdex-generic.tsv). These are the English titles from [OBDex](https://github.com/foerbsnavi/OBDex), whose data is CC0 1.0, vendored rather than fetched so that the tool works offline in a garage. The file header records the bundle it came from and [`scripts/vendor_obdex.py`](scripts/vendor_obdex.py) rebuilds it.

```sh
uv run obd-read describe P0420
uv run obd-read describe scan.json                       # uses the profile the scan recorded
uv run obd-read describe 5123 --unit esp --profile mercedes-w211
```

A code with no entry is reported as having no description, never guessed. Generic titles are not applied to a unit's hexadecimal codes, which are the maker's own numbering.

## Importing names from a definition file

The complete names for a car's codes and data live in the maker's diagnostic definition files, which are not redistributable, so none is shipped here. `import-names` reads a file you already hold, at run time, and writes the names for one unit to a new file of your choosing:

```sh
uv run obd-read import-names definitions.pdx --unit esp --output esp-names.json --variant <layer name>
uv run obd-read describe 5123 --unit esp --names esp-names.json --request "1A 86"
```

| Input | Reads |
|---|---|
| `.odx`, `.odx-d`, `.xml` or a `.pdx` archive (ODX, ISO 22901-1) | Each DTC's trouble code and text, and the name of each diagnostic service whose request is made of constant bytes. |
| `.json` written by Trafo from [CaesarSuite](https://github.com/jglim/CaesarSuite) (MIT) | Each variant's `DTCs` and, by request bytes, its `DiagServices`. Convert a Mercedes `.cbf` file with Trafo first; `obd-read` does not read CBF itself and has no dependency on CaesarSuite or on odxtools. |

Without `--variant` every diagnostic layer in the file is read, and a code whose text differs between layers keeps the first and is reported. Codes that are neither hexadecimal nor SAE form are skipped and listed. The names file holds text taken from the definition file, so keep it out of anything you publish. These readers were written from the ODX standard's element names and Trafo's source, and have been run only on synthetic files.

## Clearing fault codes

Clearing erases the evidence a fault leaves behind, so `clear` does it in a fixed order and stops at the first step that fails:

1. Reads the unit's identification, fault codes and the freeze frame for each code.
2. Writes them, with the full adapter transcript, to the `--save` file. The file must not already exist.
3. Prints the codes and asks you to type `yes`. `--yes` skips the question.
4. Sends the clear request.
5. Reads the unit again and prints what remains.

A unit that refuses its freeze frames is recorded as such and can still be cleared. A unit whose fault codes cannot be read is not cleared. One unit is cleared per run.

### Clearing without a profile

`clear-codes` is the same procedure for a car with no profile, through the legislated clear (OBD-II mode 04). Mode 04 cannot target one unit: it erases the stored codes, freeze frame and misfire data of every emissions-related unit and resets their readiness monitors, which then need a drive cycle to complete. The command says so before it asks.

1. Reads the VIN, readiness, stored, pending and permanent codes, freeze frame and misfire counts. Unreadable stored or pending codes stop the run; the optional reads are recorded as not read.
2. Writes them, with the full adapter transcript, to the `--save` file. The file must not already exist.
3. Prints what will be erased and asks you to type `yes`. `--yes` skips the question.
4. Sends mode 04, which the guard passes only with the clear token for that saved file.
5. Reads the stored and pending codes and readiness again and prints them.

It takes `--id-bits` and `--bitrate` like `obd`.

## What it will not send

Every request passes through one guard ([`src/obd_read/guard.py`](src/obd_read/guard.py)) before it reaches the adapter.

| Protocol | Services allowed |
|---|---|
| KWP2000 | `10` (default and standard diagnostic sessions), `12`, `17`, `18`, `1A`, `21`, `3E` |
| UDS | `10` (default and extended sessions), `19`, `22`, `3E` |
| OBD-II | modes `01`, `02`, `03`, `06`, `07`, `09`, `0A` |

The clear service (`14`, or OBD-II mode `04`) is sent only by the `clear` and `clear-codes` commands, after the snapshot is on disk. Everything else is refused before sending: actuator and routine control, writes, security access, resets, programming sessions and data transfer.

## Bit rates

250 and 500 kbit/s use the ELM327 protocols 6 to 9. Any other rate, such as 125 kbit/s for the mid-speed bus on pins 3 and 11 of some Ford and Volvo cars, is set by `select_can` in one of two ways, and the adapter's own reply decides whether it worked:

- **STN adapters:** the 500 kbit/s protocol is selected, then `STPBR <rate>` sets the rate and `STPBRR` reads back the rate in use. The manual says `STPBR` rounds to the nearest rate the hardware can generate and clamps without an error, so any difference from the requested rate is refused.
- **Plain ELM327:** user-defined protocol B, through `ATPC`, `ATPB <options> <divisor>` and `ATSPB`. The divisor is 500 kbit/s divided by the rate, so only rates that divide 500 kbit/s into a whole number from 1 to 64 are reachable (125 kbit/s is divisor 4). Anything else is refused before a byte is sent.

An adapter that rejects the command stops the run with the command named. Sources: the ELM327 datasheet (`AT PB`, `AT PC`, `AT SP`, PP 2B to 2D) and the OBDLink Family Reference and Programming Manual revision F (`STPBR`, `STPBRR`). The commands are tested against the scripted adapter only. Unconfirmed on hardware: whether `STPBR` takes effect before the protocol opens, which rates each STN model accepts, and whether a clone that accepts `ATPB` honours the divisor. The adapter's transceiver also has to be wired to the pins the bus uses: most adapters reach pins 6 and 14 only.

## Requests longer than one frame

A request of up to 7 bytes goes as one CAN frame on any adapter. A longer one, such as a read of several data identifiers at once, goes only through an adapter with the STN extensions: `STPX h:<id>, d:<data>` transmits it, segmented per ISO 15765-2, and turns transmit segmentation on only for that message. Addressing a unit on such an adapter also registers the unit's identifier pair with `STCFCPA`, because the adapter waits for the unit's flow-control frame and recognises it only for registered pairs. A raw CAN link (see [Raw CAN adapters](#raw-can-adapters)) segments it itself and needs no extensions. A plain ELM327 refuses a long request with a message naming the reason, since its datasheet documents no multi-frame sending; nothing is sent. The longest request is 4095 bytes, the ISO 15765-2 limit. Every long request has passed the guard like any other. Sources: the OBDLink Family Reference and Programming Manual revision F (`STPX`, `STCSEGT`, `STCFCPA`). Tested against the scripted adapter only; unconfirmed on hardware: the longest command line an adapter accepts (the manual's `l:` mode, not used here, exists for messages beyond the UART buffer), eight-digit identifiers in `h:` for 29-bit CAN, and that every STN model registers pairs for non-legislated identifiers.

## Raw CAN adapters

A raw CAN adapter has no ELM327 interpreter: it sends and receives CAN frames. `socketcan://` and `slcan://` links present one as an ELM327 adapter to the rest of the tool, so every command works unchanged, and the ISO 15765-2 work the ELM327 does in firmware (segmenting a request, sending flow control for a long reply, reassembly) is done by [`src/obd_read/isotp.py`](src/obd_read/isotp.py). A raw link has no single-frame request limit: a request can be up to 4095 bytes, sent as a first frame and consecutive frames after the unit's flow control. The session selects bit rates on it as it does on a plain ELM327, so the rates are 250 and 500 kbit/s and 500 kbit/s divided by a whole number from 1 to 64; an SLCAN adapter further limits them to the nine rates its `S` command offers.

| Link | Where | What sets the bit rate |
|---|---|---|
| `socketcan://<interface>` | Linux only: `can0`, `vcan0`, any CAN device the kernel exposes, including a candleLight adapter running gs_usb firmware | The interface: `ip link set can0 type can bitrate 500000`, outside this tool. |
| `slcan://<serial device>` | Any platform with a serial port: an adapter running SLCAN firmware, including candleLight with that firmware | The bus settings of the profile (`--bitrate` for `obd`), sent to the adapter when the bus is selected. |

SocketCAN exists only on Linux. On any other platform `socketcan://` fails with a message saying so, and the rest of the tool imports and runs as usual. SLCAN framing follows the Linux kernel's SLCAN driver ([slcan-core.c](https://github.com/torvalds/linux/blob/master/drivers/net/can/slcan/slcan-core.c)); it has been checked against that source and a scripted adapter, not against a physical adapter. A candleLight adapter with gs_usb firmware has no driver here other than the Linux kernel's, so on a Mac it needs SLCAN firmware.

The raw layer is classic CAN only (no CAN FD, no remote frames) and implements only the ELM327 commands the tool sends; anything else is answered `?` as a clone adapter does. Not confirmed: that every control unit accepts frames padded with `0xCC`, the fill byte Wikipedia recommends, and the identifier a unit sends flow control for on functional (broadcast) requests, which follows the ISO 15765-4 pairing. Frames that reach the link are the request's own frames and the flow control a reply needs; the read-only guard sits above the link and is unchanged.

## Bus monitor

`monitor` logs the frames on the bus and sends nothing. Watching a known-good tool talk to a car is the quickest way to learn the addresses and requests for a new profile.

```sh
uv run obd-read monitor --adapter slcan:///dev/ttyACM0 --id 7E8 --id 7E0 --duration 60 --output bus.log
```

Each log line is a UTC time, the identifier and the data in hexadecimal. `--id`, `--block` and `--flow-control` (each repeatable, hexadecimal) choose the identifiers kept, `--count` and `--duration` stop it, and Ctrl-C stops it at any point. `--output` writes the log to a new file and refuses to overwrite one. Status messages from the adapter, such as `BUFFER FULL`, which means frames were lost, appear in the log as `#` lines.

| Adapter | What the log holds | How it stays silent |
|---|---|---|
| Raw CAN (`slcan://`, `socketcan://`) | Every frame on the bus. | The link is opened listen-only and only its receive side reaches the monitor. SLCAN is put in listen-only mode by the tool. SocketCAN's mode belongs to the interface, so set it first: `ip link set can0 type can bitrate 500000 listen-only on`. |
| STN extensions | What passes the adapter's own filters (`STFPA`, `STFBA`, `STFFCA`), read with `STM`. | `STCMM 0`, the monitoring mode that does not acknowledge frames. |
| Plain ELM327 | What passes `ATCRA`, or `ATCF` and `ATCM` for several identifiers, read with `ATMA`. A block list is applied by the tool after the adapter. | Not confirmed: the sources used here do not say whether a plain ELM327 acknowledges frames while it monitors. |

The only commands the monitor sends to an adapter are receive filters, the monitoring commands and `STCMM 0`; anything else is refused before it is sent. The `STFFCA` argument form is assumed to match `STFPA` and `STFBA`, which is not confirmed. A busy bus can overrun an ELM327-style adapter's buffer; the raw forms do not have that limit.

## Vehicle profiles

A profile is a TOML file with the bus settings, the diagnostic protocol and one table per control unit:

```toml
name = "example-car"
description = "Example chassis"
status = "unconfirmed"       # or "confirmed" once the addresses are proven on a car

[bus]
id_bits = 11                 # 11 or 29
bitrate = 500000             # bit/s; see "Bit rates" for what an adapter can reach

[diagnostics]
protocol = "kwp2000"         # or "uds"
session = 0x92               # the session opened before reading

[units.engine]
description = "Engine control unit"
request = 0x7E0
response = 0x7E8
source = "where this address pair comes from"
```

Pass a shipped profile by name or your own by path: `--profile ./my-car.toml`. Every unit needs a `source`, so an address can be traced to where it was found. Run `obd-read profile check ./my-car.toml` before first use: beyond what loading rejects it reports unknown keys, identifiers too wide for the bus, a request and response that are the same, an identifier shared by two units and blank sources.

### K-line profiles

A car whose units answer only on K-line (ISO 9141-2 or KWP2000 over K-line, pin 7 of the diagnostic socket) names the initialisation scheme instead of CAN settings:

```toml
[bus]
kline = "kwp2000-slow"       # iso9141 (ELM327 protocol 3), kwp2000-slow (4) or kwp2000-fast (5)
tester = 0xF1                # optional: the tester's address byte
header_format = 0xC0         # optional: the first header byte, 0x68 for iso9141, 0xC0 for kwp2000

[diagnostics]
protocol = "kwp2000"         # a K-line bus carries kwp2000 only
session = 0x81

[units.engine]
description = "Engine control unit"
request = 0x01               # the unit's K-line address, also the five-baud initialisation address
response = 0x01              # the address its replies come from
source = "where this address comes from"
```

The adapter initialises the bus for one unit at a time: `ATIIA` sets the five-baud address for the slow schemes, `ATSH` the header, and `ATSI` or `ATFI` starts the initialisation before the first request to that unit. A unit that does not answer the initialisation is reported as silent. Every reply carries a checksum that the tool verifies, so a reply it cannot verify is an error and never data.

Unconfirmed, because the sources in the [vehicle notes](docs/vehicles/generic-standards.md) do not settle them: whether the adapter prints the checksum byte with headers on (a reply it cannot verify is refused rather than guessed at), what it does with the length bits of an ISO 14230 format byte (`header_format` overrides the default), and the idle message the adapter sends to keep the bus open, which is its default `68 6A F1 01 00` and is a legislated read. The ISO 9141-2 and ISO 14230-2 wire timing is the adapter's, not the tool's. Units on a second K-line, or on pins other than 7 and 15, cannot be reached by an adapter that drives pin 7 only. Adapters with the STN extensions have further ISO commands (custom fast initialisation, initialisation address parity, inter-byte timing) that the tool does not yet use.

`obd --kline iso9141|kwp2000-slow|kwp2000-fast` reads the legislated OBD-II values over K-line with no profile.

The shipped profiles are `mercedes-w211` and `vag-mqb`, both marked unconfirmed. The W211 table comes from an open-source project for a different variant of the chassis, and the MQB table from a community wiki's captures of MQB cars. `probe` is how a profile is confirmed on a given car. A profile is added only where a readable source states its addresses; for a car with none, `discover` finds them.

The [vehicle communication notes](docs/vehicles/README.md) record how to talk to other makes, with sources, for writing a new profile.

## How it is built

| Layer | Code | Job |
|---|---|---|
| Link | `transport/` | Bytes to and from the adapter: Bluetooth LE, serial, TCP. For raw CAN, frames to and from the bus (`transport/socketcan.py`, `transport/slcan.py`) with `transport/rawcan.py` and `isotp.py` presenting them as an adapter. |
| Adapter | `elm.py`, `kline.py` | The ELM327 session: set-up, addressing, one request and its reassembled replies. `kline.py` is the same session on a K-line bus. |
| Guard | `guard.py` | Passes or refuses each request. |
| Protocol | `kwp2000.py`, `uds.py`, `obd.py` | Builds requests and decodes replies. |
| Vehicle | `profile.py`, `profiles/` | What to address on a given chassis. |
| Commands | `operations.py`, `obd_clear.py`, `monitor.py`, `cli.py` | Reading a unit, scanning, saving, clearing, logging the bus. |
| Saved files | `offline.py`, `scancompare.py`, `codenames.py`, `definitions.py` | Comparing scans and naming codes, with no adapter involved. |

## Development

```sh
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

The tests run against the scripted adapter and car in [`src/obd_read/simulator.py`](src/obd_read/simulator.py), the same one the `simulate` command serves, including over a local TCP socket.

## What has and has not been tested

Everything above the link is tested against the scripted adapter. The Bluetooth LE and serial links, real adapter firmware and real control units are exercised only when someone runs the tool at a car. Bluetooth LE adapters do not share one layout: the tool picks the first service that has both a notifying and a writable characteristic, and `?service=`, `?notify=` and `?write=` on the URL override that choice.

## Licence

MIT. See [LICENSE](LICENSE).
