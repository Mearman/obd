# obd-read

Read a car's diagnostics through an ELM327-style adapter, with software you can read and change.

`obd-read` talks to the control units behind the diagnostic socket: it reads their identification, stored fault codes and freeze frames. It can also clear a unit's fault codes, after saving what it is about to erase. It has no actuator tests, coding, writes or flashing, and no setting that adds them.

## What it needs

- An adapter that implements the full ELM327 command set, reached over Bluetooth LE, a serial port (USB or classic Bluetooth) or TCP (Wi-Fi adapters). Cheap clones that lack the addressing commands are detected and named on connection. Standard `AT` commands are used throughout; on connection the tool also reports whether the adapter has the STN `ST` extensions, which it uses only where a plain ELM327 cannot do the job (see [Bit rates](#bit-rates) and [Requests longer than one frame](#requests-longer-than-one-frame)).
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
| `obd` | Legislated OBD-II reads that need no profile: VIN, warning-lamp state, stored, pending and permanent codes, a few live values. |
| `clear-codes --save <file>` | Erases the codes of every emissions unit, with no profile. See below. |
| `request <unit> <hex>` | One request of your choosing, for example `1A86`. Only read-only services are sent. |
| `discover --protocol <kwp2000\|uds>` | For a car with no profile: asks each 11-bit CAN request identifier in `--first` to `--last` (default `0x700` to `0x7FF`) to open the default session, and lists which answer and from which identifier. `--output <file>` writes the answers as an unconfirmed draft profile, named `--name`, for `profile check`. Only the guarded default-session request is sent, but every silent identifier waits out the adapter's reply timeout, so narrow the range when you can. Takes no `--profile`. |
| `simulate --profile <profile>` | Serves a scripted adapter and car over TCP on `127.0.0.1:35000` (`--host`, `--port`), so the tool and a profile can be tried with no car: `obd-read probe --adapter tcp://127.0.0.1:35000 --profile <profile>`. Every unit in the profile answers with one invented fault code, and each connection starts a fresh car, so `clear` can be tried safely. It connects to nothing. |
| `profile check <profile>...` | Validates profile files (or shipped names) without connecting to anything; exits 1 on any problem. |
| `clear <unit> --save <file>` | Erases one unit's stored fault codes. See below. |

Every command that talks to a car takes `--adapter`, and `--log <file>` to keep the full exchange with the adapter. All except `obd`, `discover` and `clear-codes` take `--profile`.

Fault codes are printed as the unit reports them: hexadecimal code bytes and a status byte. The tool carries no fault-code descriptions.

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

A request of up to 7 bytes goes as one CAN frame on any adapter. A longer one, such as a read of several data identifiers at once, goes only through an adapter with the STN extensions: `STPX h:<id>, d:<data>` transmits it, segmented per ISO 15765-2, and turns transmit segmentation on only for that message. Addressing a unit on such an adapter also registers the unit's identifier pair with `STCFCPA`, because the adapter waits for the unit's flow-control frame and recognises it only for registered pairs. A plain ELM327 refuses a long request with a message naming the reason, since its datasheet documents no multi-frame sending; nothing is sent. The longest request is 4095 bytes, the ISO 15765-2 limit. Every long request has passed the guard like any other. Sources: the OBDLink Family Reference and Programming Manual revision F (`STPX`, `STCSEGT`, `STCFCPA`). Tested against the scripted adapter only; unconfirmed on hardware: the longest command line an adapter accepts (the manual's `l:` mode, not used here, exists for messages beyond the UART buffer), eight-digit identifiers in `h:` for 29-bit CAN, and that every STN model registers pairs for non-legislated identifiers.

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

The shipped profiles are `mercedes-w211` and `vag-mqb`, both marked unconfirmed. The W211 table comes from an open-source project for a different variant of the chassis, and the MQB table from a community wiki's captures of MQB cars. `probe` is how a profile is confirmed on a given car. A profile is added only where a readable source states its addresses; for a car with none, `discover` finds them.

The [vehicle communication notes](docs/vehicles/README.md) record how to talk to other makes, with sources, for writing a new profile.

## How it is built

| Layer | Code | Job |
|---|---|---|
| Link | `transport/` | Bytes to and from the adapter: Bluetooth LE, serial, TCP. |
| Adapter | `elm.py` | The ELM327 session: set-up, addressing, one request and its reassembled replies. |
| Guard | `guard.py` | Passes or refuses each request. |
| Protocol | `kwp2000.py`, `uds.py`, `obd.py` | Builds requests and decodes replies. |
| Vehicle | `profile.py`, `profiles/` | What to address on a given chassis. |
| Commands | `operations.py`, `obd_clear.py`, `cli.py` | Reading a unit, scanning, saving, clearing. |

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
